import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from '../exec.js';
import { resolveInsideRoot, SandboxError } from './sandbox.js';

/**
 * Locate a ripgrep binary.
 * Commands run without a shell, so shell functions and aliases are unusable —
 * this must be a real executable. When none is found we fall back to `git grep`,
 * which searches tracked files only and therefore skips node_modules for free.
 */
function findRipgrep(): string | undefined {
  const explicit = process.env['RIPGREP_PATH'];
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'];
  return candidates.find((c) => existsSync(c));
}

/** Above this many matching files, return the file list instead of matching lines. */
const SUMMARY_FILE_THRESHOLD = 40;
/** Maximum matching lines shown per file. */
const PER_FILE_LIMIT = 4;
/** Maximum characters per line. A single minified line can be tens of KB. */
const MAX_LINE_LENGTH = 300;

export interface RepoState {
  readonly branch: string;
  readonly sha: string;
  readonly dirty: boolean;
}

/**
 * When too many files match, dumping lines just gets truncated at the result cap
 * and helps nobody. Return the file list so the model can narrow its next query.
 */
function summarizeFiles(files: readonly string[], pattern: string): string {
  return [
    `'${pattern}' matched ${files.length} files, so only the file list is shown instead of matching lines.`,
    '',
    files.slice(0, 60).join('\n'),
    files.length > 60 ? `… and ${files.length - 60} more files` : '',
    '',
    'Use a more specific pattern, or narrow the scope with path/glob, and search again.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function clipLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)} …(line truncated)` : line;
}

export class RepoReader {
  constructor(
    private readonly root: string,
    private readonly maxMatches: number = 200,
  ) {}

  /**
   * Snapshot info to attach to the answer, so a human can tell whether the bot
   * reasoned over stale code.
   */
  async state(): Promise<RepoState> {
    const [branch, sha, status] = await Promise.all([
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.root }),
      run('git', ['rev-parse', '--short', 'HEAD'], { cwd: this.root }),
      run('git', ['status', '--porcelain'], { cwd: this.root }),
    ]);
    return {
      branch: branch.stdout.trim(),
      sha: sha.stdout.trim(),
      dirty: status.stdout.trim().length > 0,
    };
  }

  /**
   * Top-level layout and file-type distribution.
   * Without this in the prompt, the model burns early turns searching for files
   * in languages this repository does not even contain.
   */
  async overview(): Promise<string> {
    const { stdout } = await run('git', ['ls-files'], { cwd: this.root, timeoutMs: 20_000 });
    const files = stdout.split('\n').filter((f) => f.length > 0);

    const topDirs = new Map<string, number>();
    const extensions = new Map<string, number>();
    for (const file of files) {
      const slash = file.indexOf('/');
      const top = slash === -1 ? '(root files)' : file.slice(0, slash);
      topDirs.set(top, (topDirs.get(top) ?? 0) + 1);

      const dot = file.lastIndexOf('.');
      if (dot > 0) {
        const ext = file.slice(dot);
        extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
      }
    }

    const rank = (m: Map<string, number>, n: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join(', ');

    return [
      `${files.length} tracked files`,
      `Top level: ${rank(topDirs, 12)}`,
      `File types: ${rank(extensions, 10)}`,
    ].join('\n');
  }

  async grep(pattern: string, subPath?: string, glob?: string): Promise<string> {
    // Always validate subPath. The fallback path must not bypass the sandbox either.
    const target = subPath ? resolveInsideRoot(this.root, subPath) : this.root;
    const relativeTarget = path.relative(this.root, target) || '.';
    const rg = findRipgrep();

    if (rg) {
      const { stdout, code } = await run(
        rg,
        [
          '--line-number',
          '--no-heading',
          '--color=never',
          `--max-count=${PER_FILE_LIMIT}`,
          `--max-columns=${MAX_LINE_LENGTH}`,
          '--max-columns-preview',
          '-e',
          pattern,
          ...(glob ? ['--glob', glob] : []),
          target,
        ],
        { cwd: this.root, timeoutMs: 20_000 },
      );
      if (code === 1) return `No matches for: ${pattern}`;
      return this.formatLines(stdout);
    }

    const pathspec = glob ? path.join(relativeTarget, '**', glob) : relativeTarget;

    // Step 1: file names only.
    // Asking for lines up front makes one common word dump several MB and blow the output buffer.
    const fileList = await run(
      'git',
      ['grep', '-l', '-I', '-E', '-e', pattern, '--', pathspec],
      { cwd: this.root, timeoutMs: 20_000 },
    );
    if (fileList.code === 1) return `No matches for: ${pattern}`;

    const files = fileList.stdout.split('\n').filter((f) => f.length > 0);
    if (files.length === 0) return `No matches for: ${pattern}`;
    if (files.length > SUMMARY_FILE_THRESHOLD) return summarizeFiles(files, pattern);

    // Step 2: lines, but only from that narrowed file set.
    // The per-file cap keeps the output bounded.
    const { stdout } = await run(
      'git',
      ['grep', '-n', '-I', '-E', '-m', String(PER_FILE_LIMIT), '-e', pattern, '--', ...files],
      { cwd: this.root, timeoutMs: 20_000 },
    );
    return this.formatLines(stdout);
  }

  private formatLines(stdout: string): string {
    const lines = stdout
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => (l.startsWith(this.root) ? path.relative(this.root, l) : l))
      .map(clipLine)
      .slice(0, this.maxMatches);
    return lines.join('\n');
  }

  async readFile(relativePath: string, start?: number, end?: number): Promise<string> {
    const absolute = resolveInsideRoot(this.root, relativePath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new SandboxError(`Not a file: ${relativePath}`);

    const content = await fs.readFile(absolute, 'utf8');
    if (start === undefined && end === undefined) return content;

    const lines = content.split('\n');
    const from = Math.max(1, start ?? 1);
    const to = Math.min(lines.length, end ?? lines.length);
    return lines
      .slice(from - 1, to)
      .map((line, i) => `${from + i}\t${line}`)
      .join('\n');
  }

  async listFiles(relativePath: string): Promise<string> {
    const absolute = resolveInsideRoot(this.root, relativePath || '.');
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n');
  }
}
