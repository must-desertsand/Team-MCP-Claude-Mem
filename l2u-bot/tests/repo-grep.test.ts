import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RepoReader } from '../src/repo/search.js';
import { SandboxError } from '../src/repo/sandbox.js';

let root: string;
let reader: RepoReader;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l2u-grep-test-')));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'payment.ts'), 'export function cancelPayment() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'notes.md'), 'cancelPayment cancels a payment\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'lib.ts'), 'cancelPayment noise\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  // Heavy-match case: 100 lines hit one pattern
  fs.writeFileSync(
    path.join(root, 'src', 'many.ts'),
    Array.from({ length: 100 }, (_, i) => `const line${i} = ${i};`).join('\n'),
  );
  // Per-file cap: ten hits in one file, one in another
  fs.writeFileSync(path.join(root, 'src', 'dupA.ts'), Array.from({ length: 10 }, () => 'dup').join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'dupB.ts'), 'dup\n');
  // File-count threshold case: the same word across 50 files
  fs.mkdirSync(path.join(root, 'wide'), { recursive: true });
  for (let i = 0; i < 50; i += 1) {
    fs.writeFileSync(path.join(root, 'wide', `f${i}.ts`), 'widespread\n');
  }
  // One very long line
  fs.writeFileSync(path.join(root, 'src', 'long.ts'), `const x = "LONGLINE${'z'.repeat(5000)}";\n`);

  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  reader = new RepoReader(root);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('RepoReader.grep', () => {
  it('returns matches as file:line', async () => {
    const out = await reader.grep('cancelPayment');
    expect(out).toContain('src/payment.ts:1:');
  });

  it('does not search untracked node_modules', async () => {
    const out = await reader.grep('cancelPayment');
    expect(out).not.toContain('node_modules');
  });

  it('narrows by file type with a glob', async () => {
    const out = await reader.grep('cancelPayment', undefined, '*.ts');
    expect(out).toContain('payment.ts');
    expect(out).not.toContain('notes.md');
  });

  it('returns a notice rather than an error when nothing matches', async () => {
    const out = await reader.grep('NoSuchPatternQQQ');
    expect(out).toContain('No matches for');
  });

  it('the search path cannot escape the sandbox either', async () => {
    await expect(reader.grep('x', '../..')).rejects.toThrow(SandboxError);
  });

  it('returns at most the per-file cap even when one file matches heavily', async () => {
    const out = await reader.grep('line');
    const lines = out.split('\n').filter((l) => l.startsWith('src/many.ts'));
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('limits matches per file so one file cannot dominate the result', async () => {
    const out = await reader.grep('dup');
    const fromA = out.split('\n').filter((l) => l.startsWith('src/dupA.ts')).length;
    expect(fromA).toBeLessThanOrEqual(4);
    expect(out).toContain('src/dupB.ts');
  });

  it('returns only the file list when many files match', async () => {
    const out = await reader.grep('widespread');
    expect(out).toContain('matched');
    expect(out).toContain('narrow the scope');
    // Does not dump line-numbered match bodies
    expect(out).not.toMatch(/:\d+:/);
  });

  it('clips very long lines', async () => {
    const out = await reader.grep('LONGLINE');
    const line = out.split('\n').find((l) => l.startsWith('src/long.ts'));
    expect(line).toBeDefined();
    expect(line!).toContain('line truncated');
    expect(line!.length).toBeLessThan(400);
  });
});

describe('RepoReader.readFile', () => {
  it('prefixes line numbers when a range is given', async () => {
    const out = await reader.readFile('src/payment.ts', 1, 2);
    expect(out).toBe('1\texport function cancelPayment() {\n2\t  return 1;');
  });

  it('rejects files outside the repository', async () => {
    await expect(reader.readFile('../../etc/hosts')).rejects.toThrow(SandboxError);
  });
});

describe('RepoReader.state', () => {
  it('reports the branch and commit', async () => {
    const state = await reader.state();
    expect(state.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(state.branch.length).toBeGreaterThan(0);
    expect(state.dirty).toBe(false);
  });
});
