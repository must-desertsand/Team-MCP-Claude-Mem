import OpenAI from 'openai';
import type { ModelSpec, Limits } from '../config.js';
import type { AgentOutcome, ToolCallRecord, ToolDefinition } from '../types.js';

/**
 * The litellm gateway is OpenAI-compatible, so only the baseURL changes.
 * Response messages must go back into the history unmodified — dropping the
 * provider_specific_fields.thought_signature that Gemini models attach breaks
 * multi-turn reasoning.
 */
export interface LoopDeps {
  readonly client: OpenAI;
  readonly models: readonly ModelSpec[];
  readonly compactModel: string;
  readonly tools: readonly ToolDefinition[];
  readonly limits: Limits;
  readonly logger?: (message: string) => void;
  /**
   * Called as the investigation advances, so callers can show progress.
   * Long investigations otherwise look indistinguishable from a hung bot.
   */
  readonly onProgress?: (note: string) => void;
}

type Message = Record<string, unknown>;

function isRetryableModelError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /rate.?limit|usage limit|quota|overloaded|unavailable|invalid model/i.test(message);
}

/** Rough token estimate. It only has to be good enough to decide when to compact. */
function estimateTokens(messages: readonly Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 3.5);
}

export class AgentLoop {
  constructor(private readonly deps: LoopDeps) {}

  private toolSchemas() {
    return this.deps.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  /** Walk the model chain and return the first success. Quota and overload errors move on. */
  private async complete(messages: readonly Message[]): Promise<{ message: Message; model: string }> {
    const errors: string[] = [];
    for (const spec of this.deps.models) {
      try {
        const res = await this.deps.client.chat.completions.create({
          model: spec.id,
          messages: messages as never,
          tools: this.toolSchemas(),
          tool_choice: 'auto',
        });
        const choice = res.choices[0];
        if (!choice) throw new Error('Empty response');
        return { message: choice.message as unknown as Message, model: spec.id };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push(`${spec.id}: ${detail}`);
        this.deps.logger?.(`Model ${spec.id} failed, trying the next candidate: ${detail}`);
        if (!isRetryableModelError(error)) throw error;
      }
    }
    throw new Error(`All model candidates failed.\n${errors.join('\n')}`);
  }

  /**
   * Once the accumulated input grows large, replace older tool results with a summary.
   * The system message and the four most recent messages are left untouched.
   */
  private async compactIfNeeded(messages: Message[], contextWindow: number): Promise<Message[]> {
    const budget = contextWindow * this.deps.limits.contextUsageRatio;
    if (estimateTokens(messages) < budget) return messages;

    const head = messages.slice(0, 2);
    const tail = messages.slice(-4);
    const middle = messages.slice(2, -4).filter((m) => m['role'] === 'tool');
    if (middle.length === 0) return messages;

    this.deps.logger?.(`Context threshold exceeded, compacting ${middle.length} tool results`);
    try {
      const res = await this.deps.client.chat.completions.create({
        model: this.deps.compactModel,
        messages: [
          {
            role: 'system',
            content:
              'Below are tool results collected by an agent. Compress them down to the facts needed for later judgement. Preserve every file path, line number, issue/PR number, and figure.',
          },
          { role: 'user', content: middle.map((m) => String(m['content'] ?? '')).join('\n---\n') },
        ] as never,
      });
      const summary = res.choices[0]?.message?.content ?? '';
      return [
        ...head,
        { role: 'user', content: `[Summary of earlier findings]\n${summary}` },
        ...tail,
      ];
    } catch {
      // If compaction fails, keep the original. Better than failing to answer.
      return messages;
    }
  }

  async run(systemPrompt: string, userPrompt: string): Promise<AgentOutcome> {
    const toolByName = new Map(this.deps.tools.map((t) => [t.name, t]));
    const toolCalls: ToolCallRecord[] = [];
    const contextWindow = this.deps.models[0]?.contextWindow ?? 128_000;
    const deadline = Date.now() + this.deps.limits.jobTimeoutMs;

    let messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    let lastModel = this.deps.models[0]?.id ?? 'unknown';

    for (let turn = 1; turn <= this.deps.limits.maxTurns; turn += 1) {
      if (Date.now() > deadline) {
        return this.wrapUp(messages, lastModel, turn, toolCalls, 'timeout');
      }

      messages = await this.compactIfNeeded(messages, contextWindow);
      if (turn === 1) this.deps.onProgress?.('Gathering context');
      const { message, model } = await this.complete(messages);
      lastModel = model;

      // Push the original object as-is so provider fields such as thought_signature survive.
      messages = [...messages, message];

      const calls = (message['tool_calls'] ?? []) as {
        id: string;
        function: { name: string; arguments: string };
      }[];

      if (calls.length > 0) {
        const names = [...new Set(calls.map((c) => c.function.name))].join(', ');
        this.deps.onProgress?.(`Turn ${turn}/${this.deps.limits.maxTurns} · ${names}`);
      }

      if (calls.length === 0) {
        return {
          text: String(message['content'] ?? '').trim(),
          model,
          turns: turn,
          toolCalls,
          stopReason: 'stop',
        };
      }

      const results = await Promise.all(
        calls.map(async (call) => {
          const started = Date.now();
          const tool = toolByName.get(call.function.name);
          let content: string;
          let ok = false;

          if (!tool) {
            content = `Unknown tool: ${call.function.name}`;
          } else {
            let args: Record<string, unknown> = {};
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              args = {};
            }
            const result = await tool.run(args);
            ok = result.ok;
            content = result.ok ? result.content : `Error: ${result.error}`;
            toolCalls.push({
              name: call.function.name,
              args,
              ok: result.ok,
              durationMs: Date.now() - started,
              resultBytes: Buffer.byteLength(content, 'utf8'),
            });
          }
          this.deps.logger?.(`Tool ${call.function.name} -> ${ok ? 'ok' : 'fail'}`);
          return { role: 'tool', tool_call_id: call.id, content } as Message;
        }),
      );

      messages = [...messages, ...results];
    }

    return this.wrapUp(messages, lastModel, this.deps.limits.maxTurns, toolCalls, 'max_turns');
  }

  /** When stopped by the turn or time limit, have the model conclude from what it has. */
  private async wrapUp(
    messages: readonly Message[],
    model: string,
    turns: number,
    toolCalls: readonly ToolCallRecord[],
    stopReason: 'max_turns' | 'timeout',
  ): Promise<AgentOutcome> {
    const note =
      stopReason === 'timeout'
        ? 'The time limit was reached. Draw your conclusion from what you have confirmed so far.'
        : 'The investigation turn limit was reached. Draw your conclusion from what you have confirmed so far.';
    try {
      const res = await this.deps.client.chat.completions.create({
        model,
        messages: [...messages, { role: 'user', content: `${note} State explicitly what you could not confirm.` }] as never,
      });
      return {
        text: String(res.choices[0]?.message?.content ?? '').trim(),
        model,
        turns,
        toolCalls,
        stopReason,
      };
    } catch (error) {
      return {
        text: `The investigation could not be completed. (${stopReason})`,
        model,
        turns,
        toolCalls,
        stopReason: 'error',
      };
    }
  }
}
