import type { WebClient } from '@slack/web-api';
import { toSlackMrkdwn } from './mrkdwn.js';

/** Slack rejects a message over 40,000 characters with msg_too_long. */
const SLACK_HARD_LIMIT = 39_000;
/** Practical chunk size. Long walls of text are unreadable in Slack anyway. */
const SLACK_TEXT_LIMIT = 3_800;
/** Retry chunk size after a msg_too_long, in case our accounting was off. */
const SLACK_FALLBACK_LIMIT = 1_800;

/**
 * Posts and updates the answer.
 * A placeholder goes up first so people can see the bot picked the request up,
 * then the same message is replaced with the final answer.
 */
export class SlackResponder {
  constructor(private readonly client: WebClient) {}

  async postPlaceholder(channel: string, threadTs: string): Promise<string> {
    const res = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: '_Looking into it…_',
    });
    return res.ts as string;
  }

  /**
   * Update the placeholder with progress while the agent works.
   * Failures are swallowed: progress is a nicety, never a reason to fail the job.
   */
  async updateProgress(channel: string, ts: string, note: string): Promise<void> {
    try {
      await this.client.chat.update({ channel, ts, text: `_${note.slice(0, 300)}_` });
    } catch {
      // ignore
    }
  }

  async finalize(channel: string, ts: string, text: string): Promise<void> {
    // Models write standard Markdown by habit; Slack renders its own dialect.
    await this.deliver(channel, ts, toSlackMrkdwn(text), SLACK_TEXT_LIMIT);
  }

  private async deliver(channel: string, ts: string, text: string, limit: number): Promise<void> {
    const [head, ...rest] = splitForSlack(text, limit);
    try {
      await this.client.chat.update({ channel, ts, text: head ?? '(empty response)' });
    } catch (error) {
      if (isTooLong(error) && limit > SLACK_FALLBACK_LIMIT) {
        await this.deliver(channel, ts, text, SLACK_FALLBACK_LIMIT);
        return;
      }
      throw error;
    }

    for (const chunk of rest) {
      try {
        await this.client.chat.postMessage({ channel, thread_ts: ts, text: chunk });
      } catch (error) {
        if (!isTooLong(error)) throw error;
        // Split this one chunk further rather than losing the rest of the answer.
        for (const smaller of splitForSlack(chunk, SLACK_FALLBACK_LIMIT)) {
          await this.client.chat
            .postMessage({ channel, thread_ts: ts, text: smaller.slice(0, SLACK_FALLBACK_LIMIT) })
            .catch(() => undefined);
        }
      }
    }
  }

  async fail(channel: string, ts: string, reason: string): Promise<void> {
    await this.client.chat.update({
      channel,
      ts,
      text: `Request failed.\n\`\`\`${reason.slice(0, 1500)}\`\`\``,
    });
  }
}

export function isTooLong(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /msg_too_long|message_too_long|too_long/i.test(message);
}

/**
 * Split text to fit Slack's message limit.
 * Splitting on line boundaries alone is not enough: a single paragraph with no
 * newlines can exceed the limit by itself, and that is exactly what produced
 * msg_too_long in practice. Oversized lines are hard-split.
 */
export function splitForSlack(text: string, limit = SLACK_TEXT_LIMIT): string[] {
  const bounded = Math.min(limit, SLACK_HARD_LIMIT);
  if (text.length <= bounded) return [text];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  for (const line of text.split('\n')) {
    if (line.length > bounded) {
      flush();
      chunks.push(...hardSplit(line, bounded));
      continue;
    }
    if (current.length + line.length + 1 > bounded) flush();
    current = current ? `${current}\n${line}` : line;
  }
  flush();

  return chunks.length > 0 ? chunks : [text.slice(0, bounded)];
}

/** Break an oversized line, preferring a word boundary near the cut. */
function hardSplit(line: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const boundary = window.lastIndexOf(' ');
    const cut = boundary > limit * 0.6 ? boundary : limit;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}
