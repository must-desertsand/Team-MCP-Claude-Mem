import { describe, it, expect, vi } from 'vitest';
import { SlackResponder, splitForSlack, isTooLong } from '../src/slack/responder.js';

function fakeClient(failFirstUpdateWith?: string) {
  let updateCalls = 0;
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ts: '999.111' })),
      update: vi.fn(async () => {
        updateCalls += 1;
        if (failFirstUpdateWith && updateCalls === 1) {
          throw new Error(`An API error occurred: ${failFirstUpdateWith}`);
        }
        return { ok: true };
      }),
    },
  } as any;
}

describe('splitForSlack', () => {
  it('keeps content under the limit as a single chunk', () => {
    expect(splitForSlack('short text', 100)).toEqual(['short text']);
  });

  it('splits on line boundaries', () => {
    const text = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].join('\n');
    const chunks = splitForSlack(text, 90);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 90)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });

  it('hard-splits a single line longer than the limit — the case that caused msg_too_long', () => {
    // One paragraph, no newlines. Line-boundary splitting alone leaves this intact
    // and Slack rejects it.
    const paragraph = 'word '.repeat(20_000).trim();
    const chunks = splitForSlack(paragraph, 3_800);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 3_800)).toBe(true);
  });

  it('never emits a chunk over Slack hard limit even when asked to', () => {
    const huge = 'x'.repeat(200_000);
    expect(splitForSlack(huge, 1_000_000).every((c) => c.length <= 39_000)).toBe(true);
  });

  it('prefers a word boundary when hard-splitting', () => {
    const line = `${'alpha '.repeat(100)}beta`;
    const chunks = splitForSlack(line, 120);
    expect(chunks[0]!.endsWith('alpha')).toBe(true);
  });

  it('splits text with no spaces at all', () => {
    const chunks = splitForSlack('y'.repeat(5_000), 1_000);
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.length <= 1_000)).toBe(true);
  });

  it('loses no content when splitting', () => {
    const text = `${'a'.repeat(9_000)}\nsecond line\n${'b'.repeat(5_000)}`;
    const rejoined = splitForSlack(text, 1_000).join('');
    expect(rejoined.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });
});

describe('isTooLong', () => {
  it('recognizes the Slack msg_too_long error', () => {
    expect(isTooLong(new Error('An API error occurred: msg_too_long'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isTooLong(new Error('channel_not_found'))).toBe(false);
  });
});

describe('SlackResponder delivery', () => {
  it('retries with smaller chunks when Slack reports msg_too_long', async () => {
    const client = fakeClient('msg_too_long');
    await new SlackResponder(client).finalize('C1', '1.1', 'word '.repeat(5_000));
    expect(client.chat.update).toHaveBeenCalledTimes(2);
    const retryText = client.chat.update.mock.calls[1]![0].text;
    expect(retryText.length).toBeLessThanOrEqual(1_800);
  });

  it('propagates errors that are not length related', async () => {
    const client = fakeClient('channel_not_found');
    await expect(new SlackResponder(client).finalize('C1', '1.1', 'hello')).rejects.toThrow(
      'channel_not_found',
    );
  });

  it('posts progress notes without failing the job when the update errors', async () => {
    const client = fakeClient();
    client.chat.update = vi.fn(async () => {
      throw new Error('ratelimited');
    });
    await expect(
      new SlackResponder(client).updateProgress('C1', '1.1', 'reading payment.service.ts'),
    ).resolves.toBeUndefined();
  });

  it('marks progress text as italic and caps its length', async () => {
    const client = fakeClient();
    await new SlackResponder(client).updateProgress('C1', '1.1', 'z'.repeat(1_000));
    const text = client.chat.update.mock.calls[0]![0].text;
    expect(text.startsWith('_')).toBe(true);
    expect(text.length).toBeLessThan(320);
  });

  it('converts Markdown to Slack mrkdwn before delivering', async () => {
    const client = fakeClient();
    await new SlackResponder(client).finalize('C1', '1.1', '## Findings\n**critical** issue');
    const text = client.chat.update.mock.calls[0]![0].text;
    expect(text).toBe('*Findings*\n*critical* issue');
  });
});
