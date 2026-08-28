/** A unit of work created from a Slack event. */
export interface Job {
  readonly eventId: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly userId: string;
  readonly text: string;
  readonly receivedAt: number;
}

/** A normalized Slack message. */
export interface NormalizedMessage {
  readonly ts: string;
  readonly isoTime: string;
  readonly author: string;
  readonly isBot: boolean;
  readonly text: string;
  readonly reactions: readonly string[];
  readonly replyCount: number;
}

/** Tool outcome. Failures are values, not exceptions. */
export type ToolResult =
  | { readonly ok: true; readonly content: string; readonly truncated: boolean }
  | { readonly ok: false; readonly error: string };

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly run: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolCallRecord {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly resultBytes: number;
}

export interface AgentOutcome {
  readonly text: string;
  readonly model: string;
  readonly turns: number;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly stopReason: 'stop' | 'max_turns' | 'timeout' | 'error';
}
