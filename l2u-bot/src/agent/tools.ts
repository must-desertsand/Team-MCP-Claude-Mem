import type { SlackCollector } from '../slack/collector.js';
import type { GithubReader } from '../github/reader.js';
import type { RepoReader } from '../repo/search.js';
import { renderTranscript } from '../slack/normalize.js';
import type { ToolDefinition, ToolResult } from '../types.js';
import { truncate } from './truncate.js';

export interface SlackToolDeps {
  readonly slack: SlackCollector;
  readonly defaultChannel: string;
  readonly maxResultBytes: number;
}

export interface RepoToolDeps {
  readonly github: GithubReader;
  readonly repo: RepoReader;
  readonly maxResultBytes: number;
}

export type ToolDeps = SlackToolDeps & RepoToolDeps;

function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument: ${key}`);
}

function num(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument: ${key}`);
}

/**
 * Wrap tool execution so failures become values.
 * A thrown exception kills the loop; the model needs to see the failure and pick
 * another route instead.
 */
function wrap(maxBytes: number, fn: (args: Record<string, unknown>) => Promise<string>) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const raw = await fn(args);
      const { content, truncated } = truncate(raw, maxBytes);
      return { ok: true, content, truncated };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** Slack lookup tools. They need a WebClient, so paths without Slack omit them. */
export function buildSlackTools(deps: SlackToolDeps): readonly ToolDefinition[] {
  const { slack, defaultChannel, maxResultBytes } = deps;
  const w = (fn: (a: Record<string, unknown>) => Promise<string>) => wrap(maxResultBytes, fn);

  return Object.freeze([
    {
      name: 'slack_read_thread',
      description: 'Read the full conversation of a Slack thread. thread_ts is the ts of the thread parent message.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel ID. Defaults to the current channel.' },
          thread_ts: { type: 'string', description: 'ts of the thread parent message' },
        },
        required: ['thread_ts'],
      },
      run: w(async (a) =>
        renderTranscript(await slack.readThread(str(a, 'channel', defaultChannel), str(a, 'thread_ts'))),
      ),
    },
    {
      name: 'slack_read_channel',
      description: 'Read recent channel messages to establish background context.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel ID. Defaults to the current channel.' },
          limit: { type: 'number', description: 'Number of messages to fetch (default 50, max 200)' },
        },
        required: [],
      },
      run: w(async (a) =>
        renderTranscript(
          await slack.readChannel(str(a, 'channel', defaultChannel), Math.min(num(a, 'limit', 50), 200)),
        ),
      ),
    },
    {
      name: 'slack_read_reactions',
      description: 'Read emoji reactions on a message. Useful as a signal of team agreement or dissent.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          ts: { type: 'string', description: 'ts of the target message' },
        },
        required: ['ts'],
      },
      run: w(async (a) => {
        const r = await slack.readReactions(str(a, 'channel', defaultChannel), str(a, 'ts'));
        return r.length > 0 ? r.join('\n') : 'No reactions';
      }),
    },
    {
      name: 'slack_user_info',
      description: 'Look up a Slack user\'s display name and title.',
      parameters: {
        type: 'object',
        properties: { user_id: { type: 'string' } },
        required: ['user_id'],
      },
      run: w(async (a) => slack.userInfo(str(a, 'user_id'))),
    },
  ]);
}

/** GitHub and codebase lookup tools. Usable standalone, without Slack. */
export function buildRepoTools(deps: RepoToolDeps): readonly ToolDefinition[] {
  const { github, repo, maxResultBytes } = deps;
  const w = (fn: (a: Record<string, unknown>) => Promise<string>) => wrap(maxResultBytes, fn);

  return Object.freeze([
    {
      name: 'gh_list_issues',
      description: 'List GitHub issues.',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          labels: { type: 'string', description: 'Comma-separated labels' },
          limit: { type: 'number' },
        },
        required: [],
      },
      run: w(async (a) =>
        github.listIssues(str(a, 'state', 'open'), a['labels'] as string | undefined, num(a, 'limit', 30)),
      ),
    },
    {
      name: 'gh_search_issues',
      description: 'Search issues by keyword.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
      run: w(async (a) => github.searchIssues(str(a, 'query'), num(a, 'limit', 20))),
    },
    {
      name: 'gh_get_issue',
      description: 'Read one issue including its body and comments.',
      parameters: {
        type: 'object',
        properties: { number: { type: 'number' } },
        required: ['number'],
      },
      run: w(async (a) => github.getIssue(num(a, 'number'))),
    },
    {
      name: 'gh_list_prs',
      description: 'List pull requests.',
      parameters: {
        type: 'object',
        properties: { state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'] }, limit: { type: 'number' } },
        required: [],
      },
      run: w(async (a) => github.listPrs(str(a, 'state', 'open'), num(a, 'limit', 30))),
    },
    {
      name: 'gh_get_pr',
      description: 'Read a pull request: metadata, changed files, comments, and reviews.',
      parameters: {
        type: 'object',
        properties: { number: { type: 'number' } },
        required: ['number'],
      },
      run: w(async (a) => github.getPr(num(a, 'number'))),
    },
    {
      name: 'gh_get_pr_diff',
      description: 'Read a pull request diff. Large diffs may be truncated; use repo_read_file to inspect specific files.',
      parameters: {
        type: 'object',
        properties: { number: { type: 'number' } },
        required: ['number'],
      },
      run: w(async (a) => github.getPrDiff(num(a, 'number'))),
    },
    {
      name: 'repo_grep',
      description: 'Search the local codebase by regular expression. Use it to locate files first.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression pattern' },
          path: { type: 'string', description: 'Sub-path to narrow the search' },
          glob: { type: 'string', description: "File filter, e.g. '*.ts'" },
        },
        required: ['pattern'],
      },
      run: w(async (a) =>
        repo.grep(str(a, 'pattern'), a['path'] as string | undefined, a['glob'] as string | undefined),
      ),
    },
    {
      name: 'repo_read_file',
      description: 'Read a file from the local codebase. Use start/end to read a line range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repository root' },
          start: { type: 'number' },
          end: { type: 'number' },
        },
        required: ['path'],
      },
      run: w(async (a) =>
        repo.readFile(str(a, 'path'), a['start'] as number | undefined, a['end'] as number | undefined),
      ),
    },
    {
      name: 'repo_list_files',
      description: 'List files in a directory. Use it to understand the layout.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the repository root. Defaults to "."' } },
        required: [],
      },
      run: w(async (a) => repo.listFiles(str(a, 'path', '.'))),
    },
  ]);
}

/**
 * The Phase 1 tool catalog. Every entry is read-only.
 * Adding a write tool here is a design change and requires an approval gate first.
 */
export function buildTools(deps: ToolDeps): readonly ToolDefinition[] {
  return Object.freeze([...buildSlackTools(deps), ...buildRepoTools(deps)]);
}
