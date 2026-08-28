import pkg from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { Job } from '../types.js';
import { EventDeduplicator } from './dedupe.js';

const { App, LogLevel } = pkg;

export interface GatewayOptions {
  readonly botToken: string;
  readonly appToken: string;
  readonly allowedChannels: readonly string[];
  readonly onJob: (job: Job) => void;
  readonly logger?: (message: string) => void;
}

/**
 * Socket Mode connection and event intake.
 * Handlers return immediately and hand work to a queue. Waiting on an LLM inside
 * a handler makes Slack treat the event as unacknowledged and redeliver it.
 */
export class SlackGateway {
  private readonly app: InstanceType<typeof App>;
  private readonly dedupe = new EventDeduplicator();

  constructor(private readonly options: GatewayOptions) {
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
    this.register();
  }

  get client(): WebClient {
    return this.app.client;
  }

  private isAllowed(channel: string): boolean {
    const { allowedChannels } = this.options;
    return allowedChannels.length === 0 || allowedChannels.includes(channel);
  }

  private register(): void {
    // Bolt acks Socket Mode events as soon as they arrive, so handlers must never
    // block — queue the work and return.
    this.app.event('app_mention', async ({ event, body }) => {
      const eventId = (body as { event_id?: string }).event_id ?? `${event.channel}:${event.ts}`;
      if (this.dedupe.isDuplicate(eventId)) {
        this.options.logger?.(`Dropped duplicate event: ${eventId}`);
        return;
      }
      if (!this.isAllowed(event.channel)) {
        this.options.logger?.(`Channel not allowed: ${event.channel}`);
        return;
      }

      this.options.onJob({
        eventId,
        channel: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        userId: event.user ?? 'unknown',
        text: stripBotMention(event.text ?? ''),
        receivedAt: Date.now(),
      });
    });

    this.app.event('message', async ({ event, body }) => {
      const message = event as {
        channel_type?: string;
        subtype?: string;
        bot_id?: string;
        channel: string;
        ts: string;
        thread_ts?: string;
        user?: string;
        text?: string;
      };
      // Direct messages only. In channels the bot responds to mentions.
      if (message.channel_type !== 'im' || message.subtype || message.bot_id) return;

      const eventId = (body as { event_id?: string }).event_id ?? `${message.channel}:${message.ts}`;
      if (this.dedupe.isDuplicate(eventId)) return;

      this.options.onJob({
        eventId,
        channel: message.channel,
        threadTs: message.thread_ts ?? message.ts,
        userId: message.user ?? 'unknown',
        text: message.text ?? '',
        receivedAt: Date.now(),
      });
    });

    this.app.error(async (error) => {
      this.options.logger?.(`Bolt error: ${error.message}`);
    });
  }

  async start(): Promise<void> {
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

/** Strip the leading bot mention so only the question body remains. */
export function stripBotMention(text: string): string {
  return text.replace(/^\s*<@[A-Z0-9]+>\s*/g, '').trim();
}
