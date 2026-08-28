import type { WebClient } from '@slack/web-api';
import type { NormalizedMessage } from '../types.js';
import { normalizeMessage, type RawSlackMessage } from './normalize.js';

/**
 * Reads raw Slack data and normalizes it.
 * Display names are looked up often, so they are cached for the process lifetime.
 */
export class SlackCollector {
  private readonly nameCache = new Map<string, string>();

  constructor(private readonly client: WebClient) {}

  private async resolveNames(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const missing = [...new Set(userIds)].filter((id) => id && !this.nameCache.has(id));
    await Promise.all(
      missing.map(async (id) => {
        try {
          const res = await this.client.users.info({ user: id });
          const profile = res.user?.profile;
          const name = profile?.display_name || profile?.real_name || res.user?.name || id;
          this.nameCache.set(id, name);
        } catch {
          // A failed lookup is not fatal. Fall back to the raw id.
          this.nameCache.set(id, id);
        }
      }),
    );
    return this.nameCache;
  }

  private async normalizeAll(raw: readonly RawSlackMessage[]): Promise<NormalizedMessage[]> {
    const mentioned = raw.flatMap((m) => [...(m.text ?? '').matchAll(/<@([A-Z0-9]+)/g)].map((x) => x[1]!));
    const authors = raw.map((m) => m.user).filter((u): u is string => Boolean(u));
    const names = await this.resolveNames([...authors, ...mentioned]);
    return raw.map((m) => normalizeMessage(m, names));
  }

  async readThread(channel: string, threadTs: string, limit = 200): Promise<NormalizedMessage[]> {
    const res = await this.client.conversations.replies({ channel, ts: threadTs, limit });
    return this.normalizeAll((res.messages ?? []) as RawSlackMessage[]);
  }

  async readChannel(channel: string, limit = 50, oldest?: string): Promise<NormalizedMessage[]> {
    const res = await this.client.conversations.history({ channel, limit, oldest });
    const messages = ((res.messages ?? []) as RawSlackMessage[]).slice().reverse();
    return this.normalizeAll(messages);
  }

  /**
   * Read emoji reactions.
   * `reactions.get` needs the `reactions:read` scope. Without it, message objects
   * still carry a `reactions` field, so fall back to a history lookup.
   */
  async readReactions(channel: string, ts: string): Promise<readonly string[]> {
    try {
      const res = await this.client.reactions.get({ channel, timestamp: ts, full: true });
      const message = res.message as { reactions?: { name: string; count: number }[] } | undefined;
      return (message?.reactions ?? []).map((r) => `${r.name} x${r.count}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!/missing_scope|not_allowed_token_type/.test(detail)) throw error;

      const res = await this.client.conversations.history({
        channel,
        latest: ts,
        oldest: ts,
        inclusive: true,
        limit: 1,
      });
      const message = (res.messages ?? [])[0] as { reactions?: { name: string; count: number }[] } | undefined;
      return (message?.reactions ?? []).map((r) => `${r.name} x${r.count}`);
    }
  }

  async userInfo(userId: string): Promise<string> {
    const res = await this.client.users.info({ user: userId });
    const p = res.user?.profile;
    return JSON.stringify({
      id: userId,
      name: p?.display_name || p?.real_name || res.user?.name,
      title: p?.title ?? null,
      isBot: res.user?.is_bot ?? false,
    });
  }
}
