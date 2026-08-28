export interface LlmProvider {
  complete(system: string, user: string): Promise<string>;
}

export class FakeProvider implements LlmProvider {
  queue: string[] = [];
  calls: Array<{ system: string; user: string }> = [];
  async complete(system: string, user: string): Promise<string> {
    this.calls.push({ system, user });
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeProvider queue empty");
    return next;
  }
}

export class OpenAiCompatProvider implements LlmProvider {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(system: string, user: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("LLM: no content in response");
    return content;
  }
}
