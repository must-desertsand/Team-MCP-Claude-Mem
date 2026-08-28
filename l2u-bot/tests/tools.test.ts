import { describe, it, expect, vi } from 'vitest';
import { buildTools, buildRepoTools, buildSlackTools } from '../src/agent/tools.js';

const slack = {
  readThread: vi.fn(async () => []),
  readChannel: vi.fn(async () => []),
  readReactions: vi.fn(async () => ['eyes x1']),
  userInfo: vi.fn(async () => '{"id":"U1"}'),
} as any;

const github = {
  listIssues: vi.fn(async () => '[]'),
  searchIssues: vi.fn(async () => '[]'),
  getIssue: vi.fn(async () => '{}'),
  listPrs: vi.fn(async () => '[]'),
  getPr: vi.fn(async () => '{}'),
  getPrDiff: vi.fn(async () => 'diff'),
} as any;

const repo = {
  grep: vi.fn(async () => 'src/a.ts:1:hit'),
  readFile: vi.fn(async () => 'content'),
  listFiles: vi.fn(async () => 'a.ts'),
} as any;

const deps = { slack, github, repo, defaultChannel: 'C1', maxResultBytes: 1000 };

describe('tool catalog', () => {
  it('every Phase 1 tool is read-only — no tool may imply a write', () => {
    const names = buildTools(deps).map((t) => t.name);
    const writeIndicators = /create|update|delete|post|comment|close|merge|write|edit|approve|label|assign/i;
    expect(names.filter((n) => writeIndicators.test(n))).toEqual([]);
  });

  it('exposes exactly the expected tool set', () => {
    expect(buildTools(deps).map((t) => t.name).sort()).toEqual(
      [
        'gh_get_issue', 'gh_get_pr', 'gh_get_pr_diff', 'gh_list_issues', 'gh_list_prs', 'gh_search_issues',
        'repo_grep', 'repo_list_files', 'repo_read_file',
        'slack_read_channel', 'slack_read_reactions', 'slack_read_thread', 'slack_user_info',
      ].sort(),
    );
  });

  it('building repo tools alone does not mix in Slack tools', () => {
    const names = buildRepoTools({ github, repo, maxResultBytes: 1000 }).map((t) => t.name);
    expect(names.some((n) => n.startsWith('slack_'))).toBe(false);
    expect(names).toContain('repo_grep');
  });

  it('Slack tools default to the current channel', async () => {
    const tool = buildSlackTools(deps).find((t) => t.name === 'slack_read_thread')!;
    await tool.run({ thread_ts: '123.456' });
    expect(slack.readThread).toHaveBeenCalledWith('C1', '123.456');
  });

  it('returns an error result rather than throwing when a required argument is missing', async () => {
    const tool = buildTools(deps).find((t) => t.name === 'gh_get_issue')!;
    const result = await tool.run({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('number');
  });

  it('accepts a numeric argument arriving as a string', async () => {
    const tool = buildTools(deps).find((t) => t.name === 'gh_get_pr')!;
    const result = await tool.run({ number: '42' });
    expect(result.ok).toBe(true);
    expect(github.getPr).toHaveBeenCalledWith(42);
  });

  it('catches an exception thrown by a tool and turns it into an error result', async () => {
    repo.grep.mockRejectedValueOnce(new Error('disk error'));
    const tool = buildTools(deps).find((t) => t.name === 'repo_grep')!;
    const result = await tool.run({ pattern: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('disk error');
  });

  it('truncates and says so when a result exceeds the cap', async () => {
    repo.readFile.mockResolvedValueOnce('x'.repeat(5000));
    const tool = buildTools({ ...deps, maxResultBytes: 100 }).find((t) => t.name === 'repo_read_file')!;
    const result = await tool.run({ path: 'a.ts' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.content).toContain('Truncated');
    }
  });

  it('every tool has a name, description, and parameter schema', () => {
    for (const tool of buildTools(deps)) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(5);
      expect((tool.parameters as any).type).toBe('object');
    }
  });
});
