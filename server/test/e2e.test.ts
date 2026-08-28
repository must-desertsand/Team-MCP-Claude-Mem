import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db";
import { createUser } from "../src/auth";
import { buildApp } from "../src/app";
import { FakeProvider } from "../src/provider";
import { runCompressionPass } from "../src/worker";
import type { Config } from "../src/config";

test("two users share memory end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "team-mem-"));
  const wsPath = join(dir, "workspaces.json");
  writeFileSync(wsPath, JSON.stringify({ l2u: ["mustfintech/l2u-sandbox", "mustfintech/web"] }));
  const cfg: Config = { port: 0, dbPath: ":memory:", llmBaseUrl: "", llmApiKey: "", llmModel: "",
    llmMaxConcurrent: 1, pollMs: 999999, workspacesPath: wsPath };
  const db = openDb(":memory:");
  const haseeb = createUser(db, "haseeb");
  const yameen = createUser(db, "yameen");
  const app = buildApp(db, cfg);
  const post = (token: string, events: unknown[]) => app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  });

  // Haseeb's Claude works on the backend, then the session ends
  const events = Array.from({ length: 20 }, (_, i) => ({
    kind: "tool", session: "sess-haseeb-1", repo: "mustfintech/l2u-sandbox", branch: "main",
    ts: i, tool: "Edit", input: `auth change ${i}`, result: "ok",
  }));
  expect((await post(haseeb.token, events)).status).toBe(200);
  expect((await post(haseeb.token, [{ kind: "end", session: "sess-haseeb-1", repo: "mustfintech/l2u-sandbox", ts: 99 }])).status).toBe(200);

  const fake = new FakeProvider();
  fake.queue.push(
    JSON.stringify([{ type: "change", title: "switched auth response to /auth/session shape", body: "Login endpoint now returns the new session envelope.", files: ["src/auth.ts"], tags: ["auth"] }]),
    JSON.stringify({ body: "Reworked backend auth response shape; frontend must consume the new envelope.", open_threads: "frontend update pending" }),
  );
  const stats = await runCompressionPass(db, fake);
  expect(stats.observations).toBe(1);
  expect(stats.summaries).toBe(1);

  // Yameen's Claude opens a session in a sibling repo of the same workspace
  const briefing = await app.request("/context?repo=mustfintech/web", {
    headers: { authorization: `Bearer ${yameen.token}` },
  });
  expect(briefing.status).toBe(200);
  const text = await briefing.text();
  expect(text).toContain("haseeb");
  expect(text).toContain("auth");

  // ...and can search the team memory
  const search = await app.request("/api/search?q=auth", { headers: { authorization: `Bearer ${yameen.token}` } });
  const hits = (await search.json()) as any[];
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some((h: any) => h.user === "haseeb")).toBe(true);

  // ...and haseeb's own next session gets continuity plus nothing echoed from himself
  const own = await (await app.request("/context?repo=mustfintech/l2u-sandbox", {
    headers: { authorization: `Bearer ${haseeb.token}` },
  })).text();
  expect(own).toContain("Your last session here");
  expect(own).toContain("frontend update pending");
});
