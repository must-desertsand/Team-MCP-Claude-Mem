import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../src/agent/loop.js';
import type { ToolDefinition } from '../src/types.js';
import type { Limits, ModelSpec } from '../src/config.js';

const limits: Limits = {
  maxTurns: 5,
  toolResultBytes: 10_000,
  contextUsageRatio: 0.6,
  jobTimeoutMs: 60_000,
};

const models: ModelSpec[] = [
  { id: 'model-a', contextWindow: 100_000 },
  { id: 'model-b', contextWindow: 100_000 },
];

const echoTool: ToolDefinition = {
  name: 'repo_grep',
  description: 'test',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async (args) => ({ ok: true, content: `found: ${JSON.stringify(args)}`, truncated: false }),
};

const failingTool: ToolDefinition = {
  name: 'broken',
  description: 'test',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ ok: false, error: 'disk unavailable' }),
};

/** Stands in for the OpenAI client, returning canned responses in order. */
function fakeClient(responses: unknown[]) {
  const calls: any[] = [];
  const create = vi.fn(async (body: any) => {
    calls.push(body);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { chat: { completions: { create } } } as any, calls, create };
}

function assistantWithToolCall(name: string, args: object, extra: object = {}) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          ...extra,
        },
      },
    ],
  };
}

function assistantFinal(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }] };
}

describe('AgentLoop', () => {
  it('runs a tool call, feeds the result into the next turn, then answers', async () => {
    const { client, calls } = fakeClient([
      assistantWithToolCall('repo_grep', { pattern: 'cancel' }),
      assistantFinal('Conclusion: the cancel logic lives in X.'),
    ]);

    const outcome = await new AgentLoop({
      client,
      models,
      compactModel: 'compact',
      tools: [echoTool],
      limits,
    }).run('sys', 'user');

    expect(outcome.stopReason).toBe('stop');
    expect(outcome.turns).toBe(2);
    expect(outcome.text).toContain('cancel logic');
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]!.ok).toBe(true);

    const secondRequest = calls[1];
    const toolMessage = secondRequest.messages.find((m: any) => m.role === 'tool');
    expect(toolMessage.tool_call_id).toBe('call_1');
    expect(toolMessage.content).toContain('found');
  });

  it('returns Gemini thought_signature unmodified in the next request', async () => {
    const signature = { provider_specific_fields: { thought_signature: 'SIG-123' } };
    const { client, calls } = fakeClient([
      assistantWithToolCall('repo_grep', { pattern: 'x' }, signature),
      assistantFinal('done'),
    ]);

    await new AgentLoop({ client, models, compactModel: 'c', tools: [echoTool], limits }).run('sys', 'user');

    const assistantMessage = calls[1].messages.find((m: any) => m.role === 'assistant');
    expect(assistantMessage.provider_specific_fields.thought_signature).toBe('SIG-123');
  });

  it('moves to the next model when the first hits a quota limit', async () => {
    const rateLimited = Object.assign(new Error('Monthly usage limit reached'), { status: 429 });
    const { client, calls } = fakeClient([rateLimited, assistantFinal('answered by the second model')]);

    const outcome = await new AgentLoop({
      client,
      models,
      compactModel: 'c',
      tools: [echoTool],
      limits,
    }).run('sys', 'user');

    expect(outcome.model).toBe('model-b');
    expect(outcome.text).toBe('answered by the second model');
    expect(calls.map((c) => c.model)).toEqual(['model-a', 'model-b']);
  });

  it('throws when every model fails', async () => {
    const err = Object.assign(new Error('overloaded'), { status: 503 });
    const { client } = fakeClient([err, err]);

    await expect(
      new AgentLoop({ client, models, compactModel: 'c', tools: [echoTool], limits }).run('s', 'u'),
    ).rejects.toThrow(/All model candidates failed/);
  });

  it('passes tool failure to the model as an error string rather than throwing', async () => {
    const { client, calls } = fakeClient([
      assistantWithToolCall('broken', {}),
      assistantFinal('the tool failed, taking another route'),
    ]);

    const outcome = await new AgentLoop({
      client,
      models,
      compactModel: 'c',
      tools: [failingTool],
      limits,
    }).run('sys', 'user');

    expect(outcome.stopReason).toBe('stop');
    const toolMessage = calls[1].messages.find((m: any) => m.role === 'tool');
    expect(toolMessage.content).toContain('disk unavailable');
    expect(outcome.toolCalls[0]!.ok).toBe(false);
  });

  it('reports an unknown tool call and keeps the loop going', async () => {
    const { client, calls } = fakeClient([
      assistantWithToolCall('gh_create_issue', { title: 'x' }),
      assistantFinal('there are no write tools'),
    ]);

    const outcome = await new AgentLoop({
      client,
      models,
      compactModel: 'c',
      tools: [echoTool],
      limits,
    }).run('sys', 'user');

    const toolMessage = calls[1].messages.find((m: any) => m.role === 'tool');
    expect(toolMessage.content).toContain('Unknown tool');
    expect(outcome.stopReason).toBe('stop');
  });

  it('concludes from what it has when the turn limit hits, flagged max_turns', async () => {
    // After maxTurns (5) tool calls the loop stops, then makes one final call
    // to get a conclusion from the evidence gathered so far.
    const responses = Array.from({ length: 5 }, () => assistantWithToolCall('repo_grep', { pattern: 'x' }));
    const { client } = fakeClient([...responses, assistantFinal('partial conclusion')]);

    const outcome = await new AgentLoop({
      client,
      models,
      compactModel: 'c',
      tools: [echoTool],
      limits,
    }).run('sys', 'user');

    expect(outcome.stopReason).toBe('max_turns');
    expect(outcome.turns).toBe(5);
    expect(outcome.text).toBe('partial conclusion');
  });

  it('reports progress as the investigation advances', async () => {
    const notes: string[] = [];
    const { client } = fakeClient([
      assistantWithToolCall('repo_grep', { pattern: 'x' }),
      assistantFinal('done'),
    ]);

    await new AgentLoop({
      client,
      models,
      compactModel: 'c',
      tools: [echoTool],
      limits,
      onProgress: (n) => notes.push(n),
    }).run('sys', 'user');

    expect(notes[0]).toBe('Gathering context');
    expect(notes.some((n) => n.includes('repo_grep'))).toBe(true);
    expect(notes.some((n) => /Turn \d+\/\d+/.test(n))).toBe(true);
  });

  it('works without a progress callback', async () => {
    const { client } = fakeClient([assistantFinal('done')]);
    const outcome = await new AgentLoop({
      client,
      models,
      compactModel: 'c',
      tools: [echoTool],
      limits,
    }).run('sys', 'user');
    expect(outcome.text).toBe('done');
  });
});
