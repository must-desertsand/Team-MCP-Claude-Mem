import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createUser } from "../src/auth";
import { buildApp } from "../src/app";
import type { Config } from "../src/config";

const CFG: Config = {
  port: 0, dbPath: ":memory:", llmBaseUrl: "", llmApiKey: "", llmModel: "",
  llmMaxConcurrent: 1, pollMs: 999999, workspacesPath: "/nonexistent.json",
};

function setup() {
  const db = openDb(":memory:");
  const member = createUser(db, "haseeb");
  const service = createUser(db, "l2u-work", "service");
  const app = buildApp(db, CFG);
  return { db, member, service, app };
}
const evt = (over: object = {}) => ({
  kind: "prompt", session: "sess-0001", repo: "mustfintech/web",
  branch: "main", ts: 111, text: "hello", ...over,
});
const post = (app: any, token: string, body: unknown) =>
  app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe("app basics", () => {
  test("health is open, everything else needs auth", async () => {
    const { app } = setup();
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/ingest", { method: "POST" })).status).toBe(401);
  });
  test("service role cannot ingest", async () => {
    const { app, service } = setup();
    expect((await post(app, service.token, { events: [evt()] })).status).toBe(403);
  });
});

describe("POST /ingest", () => {
  test("accepts batch, stamps rows, upserts session and project", async () => {
    const { db, app, member } = setup();
    const res = await post(app, member.token, {
      events: [evt(), evt({ kind: "tool", tool: "Edit", input: "x", result: "y", ts: 222 })],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2, rejected: 0 });
    const events = db.query(`SELECT * FROM events`).all() as any[];
    expect(events.length).toBe(2);
    expect(events[0].user_id).toBe(member.id);
    expect(events[0].ts).toBeGreaterThan(1000000); // server time, not client 111
    const session = db.query(`SELECT * FROM sessions WHERE id='sess-0001'`).get() as any;
    expect(session.user_id).toBe(member.id);
    expect(session.branch).toBe("main");
    expect(session.ended_at).toBeNull();
    const project = db.query(`SELECT * FROM projects`).get() as any;
    expect(project.repo_key).toBe("mustfintech/web");
  });
  test("end event sets ended_at", async () => {
    const { db, app, member } = setup();
    await post(app, member.token, { events: [evt(), evt({ kind: "end", ts: 333 })] });
    const s = db.query(`SELECT ended_at FROM sessions WHERE id='sess-0001'`).get() as any;
    expect(s.ended_at).not.toBeNull();
  });
  test("rejects events for another user's session", async () => {
    const { db, app, member } = setup();
    const other = createUser(db, "yameen");
    await post(app, member.token, { events: [evt()] });
    const res = await post(app, other.token, { events: [evt({ text: "hijack" })] });
    const body = await res.json();
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
  });
  test("rejects malformed events but accepts valid ones in same batch", async () => {
    const { app, member } = setup();
    const res = await post(app, member.token, {
      events: [evt(), { kind: "nope" }, evt({ repo: "not-a-repo-key" })],
    });
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(2);
  });
  test("413 on oversized body", async () => {
    const { app, member } = setup();
    const res = await post(app, member.token, { events: [evt({ text: "x".repeat(300_000) })] });
    expect(res.status).toBe(413);
  });
});
