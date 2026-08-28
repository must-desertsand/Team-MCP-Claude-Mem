import { describe, it, expect, vi, beforeEach } from 'vitest';

const runMock = vi.fn();
vi.mock('../src/exec.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  ExecError: class ExecError extends Error {},
}));

const { GithubReader } = await import('../src/github/reader.js');

beforeEach(() => {
  runMock.mockReset();
  runMock.mockResolvedValue({ stdout: '[]', stderr: '', code: 0 });
});

describe('GithubReader', () => {
  it('always pins the target repository — the model cannot reach another one', async () => {
    await new GithubReader('org/repo').listIssues();
    const [command, args] = runMock.mock.calls[0]!;
    expect(command).toBe('gh');
    expect(args).toContain('--repo');
    expect(args[args.indexOf('--repo') + 1]).toBe('org/repo');
  });

  it('passes arguments as an array so no shell interpretation occurs', async () => {
    await new GithubReader('org/repo').searchIssues('payment cancel OR "quoted"; rm -rf /');
    const [, args] = runMock.mock.calls[0]!;
    expect(args).toContain('payment cancel OR "quoted"; rm -rf /');
    expect(runMock.mock.calls[0]![0]).toBe('gh');
  });

  it('invokes read-only subcommands only', async () => {
    const reader = new GithubReader('org/repo');
    await Promise.all([
      reader.listIssues(), reader.getIssue(1), reader.listPrs(),
      reader.getPr(2), reader.getPrDiff(3), reader.searchIssues('q'),
    ]);
    const verbs = runMock.mock.calls.map(([, args]: any) => `${args[0]} ${args[1]}`);
    expect(new Set(verbs)).toEqual(new Set(['issue list', 'issue view', 'pr list', 'pr view', 'pr diff']));
  });

  it('throws with stderr attached when gh returns a failure code', async () => {
    runMock.mockResolvedValue({ stdout: '', stderr: 'not found', code: 1 });
    await expect(new GithubReader('org/repo').getIssue(99)).rejects.toThrow(/not found/);
  });

  it('passes the issue number as a string argument', async () => {
    await new GithubReader('org/repo').getIssue(42);
    expect(runMock.mock.calls[0]![1]).toContain('42');
  });
});
