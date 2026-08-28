import type { NormalizedMessage } from '../types.js';

export interface RawSlackMessage {
  readonly ts: string;
  readonly text?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly reply_count?: number;
  readonly reactions?: readonly {
    readonly name: string;
    readonly count: number;
    readonly users?: readonly string[];
  }[];
}

const KST_OFFSET_MS = 9 * 60 * 60_000;

/** Convert a Slack epoch string to a KST ISO string. Readable times matter for judgement. */
export function toKstIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return ts;
  const shifted = new Date(seconds * 1000 + KST_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 19)}+09:00`;
}

/**
 * Flatten Slack markup into plain text the model reads well.
 * Mentions become display names; links become `label(url)`.
 */
export function expandMarkup(text: string, displayNames: ReadonlyMap<string, string>): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => {
      const name = displayNames.get(id);
      return name ? `@${name}` : `@${id}`;
    })
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_m, _id: string, name: string) => `#${name}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, (_m, url: string, label: string) => `${label}(${url})`)
    .replace(/<(https?:\/\/[^|>]+)>/g, (_m, url: string) => url);
}

export function normalizeMessage(
  raw: RawSlackMessage,
  displayNames: ReadonlyMap<string, string>,
): NormalizedMessage {
  const isBot = Boolean(raw.bot_id) || !raw.user;
  return Object.freeze({
    ts: raw.ts,
    isoTime: toKstIso(raw.ts),
    author: isBot ? 'bot' : (displayNames.get(raw.user as string) ?? (raw.user as string)),
    isBot,
    text: expandMarkup(raw.text ?? '', displayNames),
    reactions: Object.freeze((raw.reactions ?? []).map((r) => `${r.name} x${r.count}`)),
    replyCount: raw.reply_count ?? 0,
  });
}

const OPEN_TAG = '<untrusted_slack_content>';
const CLOSE_TAG = '</untrusted_slack_content>';

/**
 * If message text contains something that looks like the boundary tag, the model
 * may misread where untrusted content ends. Neutralize it so exactly one pair exists.
 */
function neutralizeBoundary(text: string): string {
  return text.split(OPEN_TAG).join('(open_tag)').split(CLOSE_TAG).join('(close_tag)');
}

/** Render normalized messages as a transcript wrapped in the trust boundary. */
export function renderTranscript(messages: readonly NormalizedMessage[]): string {
  const body = messages
    .map((m) => {
      const reactions = m.reactions.length > 0 ? ` [reactions: ${m.reactions.join(', ')}]` : '';
      const replies = m.replyCount > 0 ? ` [${m.replyCount} replies]` : '';
      return `[${m.isoTime}] ${m.author}: ${neutralizeBoundary(m.text)}${reactions}${replies}`;
    })
    .join('\n');
  return `${OPEN_TAG}\n${body}\n${CLOSE_TAG}`;
}
