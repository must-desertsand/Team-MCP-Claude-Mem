import { describe, expect, test } from "bun:test";
import { FakeProvider, OpenAiCompatProvider } from "../src/provider";

describe("FakeProvider", () => {
  test("returns queued responses in order and records calls", async () => {
    const p = new FakeProvider();
    p.queue.push("one", "two");
    expect(await p.complete("s1", "u1")).toBe("one");
    expect(await p.complete("s2", "u2")).toBe("two");
    expect(p.calls.map(c => c.user)).toEqual(["u1", "u2"]);
    expect(p.complete("s", "u")).rejects.toThrow();
  });
});

describe("OpenAiCompatProvider", () => {
  test("posts chat/completions and returns message content", async () => {
    let captured: { url: string; body: any; auth: string | null } | null = null;
    const stubFetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization ?? null };
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }] }), { status: 200 });
    }) as typeof fetch;
    const p = new OpenAiCompatProvider("http://llm.local/v1/", "sk-x", "glm-5.2", stubFetch);
    const out = await p.complete("sys", "usr");
    expect(out).toBe("hi there");
    expect(captured!.url).toBe("http://llm.local/v1/chat/completions");
    expect(captured!.body.model).toBe("glm-5.2");
    expect(captured!.body.messages).toEqual([
      { role: "system", content: "sys" }, { role: "user", content: "usr" },
    ]);
    expect(captured!.auth).toBe("Bearer sk-x");
  });
  test("throws on HTTP error and on missing content", async () => {
    const p500 = new OpenAiCompatProvider("http://x", "", "m", (async () => new Response("no", { status: 500 })) as unknown as typeof fetch);
    expect(p500.complete("s", "u")).rejects.toThrow("LLM 500");
    const pEmpty = new OpenAiCompatProvider("http://x", "", "m", (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch);
    expect(pEmpty.complete("s", "u")).rejects.toThrow();
  });
  test("omits auth header when apiKey empty", async () => {
    let auth: string | undefined = "unset";
    const stub = (async (_: any, init: any) => {
      auth = init.headers.authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }));
    }) as typeof fetch;
    await new OpenAiCompatProvider("http://x", "", "m", stub).complete("s", "u");
    expect(auth).toBeUndefined();
  });
});
