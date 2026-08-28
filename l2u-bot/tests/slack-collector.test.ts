import { describe, it, expect, vi } from 'vitest';
import { SlackCollector } from '../src/slack/collector.js';
import { SlackResponder } from '../src/slack/responder.js';

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    users: {
      info: vi.fn(async ({ user }: { user: string }) => ({
        user: { name: user, profile: { display_name: `name-${user}`, title: 'Engineer' }, is_bot: false },
      })),
    },
    conversations: {
      replies: vi.fn(async () => ({
        messages: [
          { ts: '1700000000.000100', user: 'U111', text: '<@U222> please take a look' },
          { ts: '1700000001.000200', user: 'U222', text: 'saw it', reactions: [{ name: 'eyes', count: 1 }] },
        ],
      })),
      history: vi.fn(async () => ({
        messages: [
          { ts: '1700000002.000300', user: 'U111', text: 'later message' },
          { ts: '1700000001.000200', user: 'U111', text: 'earlier message' },
        ],
      })),
    },
    reactions: { get: vi.fn(async () => ({ message: { reactions: [{ name: 'ok', count: 3 }] } })) },
    chat: {
      postMessage: vi.fn(async () => ({ ts: '999.111' })),
      update: vi.fn(async () => ({ ok: true })),
    },
    ...overrides,
  } as any;
}

describe('SlackCollector', () => {
  it('reads a thread and swaps mentions for display names', async () => {
    const messages = await new SlackCollector(fakeClient()).readThread('C1', '1700000000.000100');
    expect(messages[0]!.text).toBe('@name-U222 please take a look');
    expect(messages[0]!.author).toBe('name-U111');
  });

  it('normalizes reactions alongside messages', async () => {
    const messages = await new SlackCollector(fakeClient()).readThread('C1', 't');
    expect(messages[1]!.reactions).toEqual(['eyes x1']);
  });

  it('reverses channel history into chronological order', async () => {
    const messages = await new SlackCollector(fakeClient()).readChannel('C1');
    expect(messages.map((m) => m.text)).toEqual(['earlier message', 'later message']);
  });

  it('caches display names so a user is not looked up twice', async () => {
    const client = fakeClient();
    const collector = new SlackCollector(client);
    await collector.readThread('C1', 't');
    await collector.readThread('C1', 't');
    const asked = client.users.info.mock.calls.map((c: any) => c[0].user);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('uses reactions.get when it is permitted', async () => {
    const r = await new SlackCollector(fakeClient()).readReactions('C1', '1.2');
    expect(r).toEqual(['ok x3']);
  });

  it('falls back to a history lookup for reactions without the reactions:read scope', async () => {
    const client = fakeClient();
    client.reactions.get = vi.fn(async () => {
      throw new Error('An API error occurred: missing_scope');
    });
    client.conversations.history = vi.fn(async () => ({
      messages: [{ ts: '1.2', user: 'U1', text: 'x', reactions: [{ name: 'eyes', count: 2 }] }],
    }));
    const r = await new SlackCollector(client).readReactions('C1', '1.2');
    expect(r).toEqual(['eyes x2']);
    expect(client.conversations.history.mock.calls[0]![0]).toMatchObject({
      latest: '1.2',
      oldest: '1.2',
      inclusive: true,
    });
  });

  it('does not swallow errors unrelated to scopes', async () => {
    const client = fakeClient();
    client.reactions.get = vi.fn(async () => {
      throw new Error('channel_not_found');
    });
    await expect(new SlackCollector(client).readReactions('C1', '1.2')).rejects.toThrow('channel_not_found');
  });

  it('survives a failed user lookup', async () => {
    const client = fakeClient();
    client.users.info = vi.fn(async () => {
      throw new Error('user_not_found');
    });
    const messages = await new SlackCollector(client).readThread('C1', 't');
    expect(messages[0]!.author).toBe('U111');
  });
});

describe('SlackResponder', () => {
  it('posts a placeholder and returns its ts', async () => {
    const client = fakeClient();
    const ts = await new SlackResponder(client).postPlaceholder('C1', 'T1');
    expect(ts).toBe('999.111');
    expect(client.chat.postMessage.mock.calls[0]![0].thread_ts).toBe('T1');
  });

  it('overwrites the placeholder with the final answer', async () => {
    const client = fakeClient();
    await new SlackResponder(client).finalize('C1', '999.111', 'Conclusion');
    expect(client.chat.update.mock.calls[0]![0]).toMatchObject({ channel: 'C1', ts: '999.111', text: 'Conclusion' });
  });

  it('updates with the first chunk and appends the rest to the thread', async () => {
    const client = fakeClient();
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    await new SlackResponder(client).finalize('C1', '999.111', long);
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage.mock.calls.length).toBeGreaterThan(0);
  });

  it('leaves the failure reason in the thread — it never goes silent', async () => {
    const client = fakeClient();
    await new SlackResponder(client).fail('C1', '999.111', 'all models failed');
    expect(client.chat.update.mock.calls[0]![0].text).toContain('all models failed');
  });
});
