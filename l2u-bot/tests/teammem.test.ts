import { describe, it, expect, vi } from 'vitest';
import { TeamMemClient } from '../src/teammem/client.js';
import { buildTeamMemTools, buildTools } from '../src/agent/tools.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';

const STATUS_JSON = [
  {
    user: 'haseeb',
    active: { repo: 'mustfintech/l2u-sandbox', branch: 'main', minutesAgo: 4 },
    recent: ['[mustfintech/l2u-sandbox · 2 h ago] Reworked auth response shape'],
  },
  { user: 'yameen', active: null, recent: [] },
];

const SEARCH_JSON = [
  {
    id: 'o12',
    ts: 1,
    rel: '2 h ago',
    user: 'haseeb',
    repo: 'mustfintech/l2u-sandbox',
    type: 'change',
    title: 'switched auth response to /auth/session shape',
  },
];

function stubFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('TeamMemClient', () => {
  it('formats status: active sessions, recent work, and idle members', async () => {
    const fetchImpl = stubFetch(STATUS_JSON);
    const client = new TeamMemClient('http://tm:7337', 'tm_x', fetchImpl);
    const out = await client.status();
    expect(out).toContain('haseeb');
    expect(out).toContain('ACTIVE now');
    expect(out).toContain('mustfintech/l2u-sandbox');
    expect(out).toContain('Reworked auth response shape');
    expect(out).toContain('yameen');
    expect(out).toContain('no recent activity');
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(call[0])).toBe('http://tm:7337/api/status');
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer tm_x' });
  });

  it('passes workspace and days as query params', async () => {
    const fetchImpl = stubFetch([]);
    const client = new TeamMemClient('http://tm:7337/', 'tm_x', fetchImpl);
    await client.status('l2u', 7);
    const url = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toBe('http://tm:7337/api/status?workspace=l2u&days=7');
  });

  it('formats search hits with id, author, age, and title', async () => {
    const client = new TeamMemClient('http://tm:7337', 'tm_x', stubFetch(SEARCH_JSON));
    const out = await client.search('auth');
    expect(out).toContain('o12');
    expect(out).toContain('haseeb');
    expect(out).toContain('2 h ago');
    expect(out).toContain('change: switched auth response to /auth/session shape');
  });

  it('says so when a search has no hits', async () => {
    const client = new TeamMemClient('http://tm:7337', 'tm_x', stubFetch([]));
    expect(await client.search('nothing')).toContain('No matches');
  });

  it('throws a labeled error on a non-2xx response', async () => {
    const client = new TeamMemClient('http://tm:7337', 'tm_bad', stubFetch({ error: 'unauthorized' }, 401));
    await expect(client.status()).rejects.toThrow('team-mem 401');
  });
});

describe('team-mem tools', () => {
  const teamMem = {
    status: vi.fn(async () => 'haseeb: ACTIVE now'),
    search: vi.fn(async () => 'o12 · hit'),
  } as unknown as TeamMemClient;

  const baseDeps = {
    slack: {
      readThread: vi.fn(async () => []),
      readChannel: vi.fn(async () => []),
      readReactions: vi.fn(async () => []),
      userInfo: vi.fn(async () => ''),
    } as any,
    github: {} as any,
    repo: {} as any,
    defaultChannel: 'C1',
    maxResultBytes: 1000,
  };

  it('exposes exactly two read-only tools', () => {
    const names = buildTeamMemTools({ teamMem, maxResultBytes: 1000 }).map((t) => t.name);
    expect(names.sort()).toEqual(['team_search', 'team_status']);
    const writeIndicators = /create|update|delete|post|comment|close|merge|write|edit|approve|label|assign/i;
    expect(names.filter((n) => writeIndicators.test(n))).toEqual([]);
  });

  it('buildTools without teamMem keeps the original catalog', () => {
    const names = buildTools(baseDeps).map((t) => t.name);
    expect(names).not.toContain('team_status');
    expect(names).not.toContain('team_search');
  });

  it('buildTools with teamMem appends both tools', () => {
    const names = buildTools({ ...baseDeps, teamMem }).map((t) => t.name);
    expect(names).toContain('team_status');
    expect(names).toContain('team_search');
  });

  it('team_search requires a query and forwards optional filters', async () => {
    const tools = buildTeamMemTools({ teamMem, maxResultBytes: 1000 });
    const search = tools.find((t) => t.name === 'team_search')!;
    const missing = await search.run({});
    expect(missing.ok).toBe(false);
    const ok = await search.run({ query: 'auth', user: 'haseeb', limit: 5 });
    expect(ok.ok).toBe(true);
    expect((teamMem.search as any)).toHaveBeenCalledWith('auth', {
      workspace: undefined,
      user: 'haseeb',
      type: undefined,
      limit: 5,
    });
  });

  it('turns a client failure into an error result, not a thrown exception', async () => {
    (teamMem.status as any).mockRejectedValueOnce(new Error('team-mem 503'));
    const status = buildTeamMemTools({ teamMem, maxResultBytes: 1000 }).find((t) => t.name === 'team_status')!;
    const result = await status.run({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('team-mem 503');
  });
});

describe('system prompt team-mem section', () => {
  const ctx = {
    repoFullName: 'mustfintech/l2u-sandbox',
    repoBranch: 'main',
    repoSha: 'abc1234',
    repoDirty: false,
    repoOverview: 'files',
    channel: 'C1',
    threadTs: '1.2',
    requester: 'U1',
    nowKst: '2026-08-28T13:00:00+09:00',
  };

  it('mentions team memory tools only when available', () => {
    expect(buildSystemPrompt({ ...ctx, teamMemAvailable: true })).toContain('team_status');
    expect(buildSystemPrompt(ctx)).not.toContain('team_status');
  });
});
