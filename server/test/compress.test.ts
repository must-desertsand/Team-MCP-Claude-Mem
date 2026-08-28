import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createUser } from "../src/auth";
import { ingestEvents } from "../src/ingest";
import { FakeProvider } from "../src/provider";
import { runCompressionPass, BATCH_MIN, ABANDON_MS } from "../src/worker";
import { extractJson } from "../src/prompts";

const MAP = { l2u: ["mustfintech/web"] };
const OBS_JSON = JSON.stringify([
  { type: "decision", title: "use JWT for auth", body: "Chose stateless JWT.", files: ["src/auth.ts"], tags: ["auth"] },
  { type: "bug", title: "login 500 on empty email", body: "Validator missing.", files: [], tags: ["login"] },
]);
const SUM_JSON = JSON.stringify({ body: "Worked on auth flow end to end.", open_threads: "refresh tokens pending" });

function setup() {
  const db = openDb(":memory:");
  const user = createUser(db, "haseeb");
  const userRow = { id: user.id, name: user.name, role: "member", token_hash: "", created_at: 0 } as any;
  return { db, userRow };
}
const mkEvents = (n: number, kind: "tool" | "end" = "tool", session = "sess-0001") =>
  Array.from({ length: n }, (_, i) => ({
    kind, session, repo: "mustfintech/web", ts: i,
    ...(kind === "tool" ? { tool: "Edit", input: `edit ${i}`, result: "ok" } : {}),
  }));

describe("extractJson", () => {
  test("parses direct, fenced, and embedded JSON; null on garbage", () => {
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(extractJson('Sure!\n```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(extractJson('Here you go: [{"a":1}] hope it helps')).toEqual([{ a: 1 }]);
    expect(extractJson("no json at all")).toBeNull();
  });
});

describe("runCompressionPass", () => {
  test("extracts observations when batch threshold reached", async () => {
    const { db, userRow } = setup();
    ingestEvents(db, MAP, userRow, mkEvents(BATCH_MIN));
    const fake = new FakeProvider();
    fake.queue.push(OBS_JSON);
    const stats = await runCompressionPass(db, fake);
    expect(stats.observations).toBe(2);
    expect((db.query(`SELECT COUNT(*) AS n FROM events WHERE compressed = 1`).get() as any).n).toBe(BATCH_MIN);
    const obs = db.query(`SELECT * FROM observations ORDER BY id`).all() as any[];
    expect(obs[0].title).toBe("use JWT for auth");
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].user).toContain("edit 3");
  });
  test("session end triggers extraction below threshold plus summary in one pass", async () => {
    const { db, userRow } = setup();
    ingestEvents(db, MAP, userRow, [...mkEvents(5), ...mkEvents(1, "end")]);
    const fake = new FakeProvider();
    fake.queue.push(OBS_JSON, SUM_JSON);
    const stats = await runCompressionPass(db, fake);
    expect(stats.observations).toBe(2);
    expect(stats.summaries).toBe(1);
    const s = db.query(`SELECT * FROM summaries`).get() as any;
    expect(s.body).toContain("auth flow");
    expect(s.open_threads).toContain("refresh");
  });
  test("malformed output retries then parks after 3 attempts", async () => {
    const { db, userRow } = setup();
    ingestEvents(db, MAP, userRow, mkEvents(BATCH_MIN));
    const fake = new FakeProvider();
    fake.queue.push("garbage", "still garbage", "nope");
    await runCompressionPass(db, fake);
    await runCompressionPass(db, fake);
    const stats = await runCompressionPass(db, fake);
    expect(stats.parked).toBe(BATCH_MIN);
    expect((db.query(`SELECT COUNT(*) AS n FROM events WHERE compressed = -1`).get() as any).n).toBe(BATCH_MIN);
    expect((db.query(`SELECT COUNT(*) AS n FROM observations`).get() as any).n).toBe(0);
  });
  test("provider outage (throwing complete) leaves the batch untouched, no attempts/parking; recovers once the provider comes back", async () => {
    const { db, userRow } = setup();
    ingestEvents(db, MAP, userRow, mkEvents(BATCH_MIN));
    const fake = new FakeProvider(); // empty queue -> complete() throws every call
    for (let i = 0; i < 3; i++) {
      const stats = await runCompressionPass(db, fake);
      expect(stats.parked).toBe(0);
      expect(stats.observations).toBe(0);
    }
    const rows = db.query(`SELECT compressed, attempts FROM events`).all() as any[];
    expect(rows.length).toBe(BATCH_MIN);
    for (const r of rows) {
      expect(r.compressed).toBe(0);
      expect(r.attempts).toBe(0);
    }
    // Provider recovers: queue a valid response and confirm the same events compress normally.
    fake.queue.push(OBS_JSON);
    const stats = await runCompressionPass(db, fake);
    expect(stats.observations).toBe(2);
    expect((db.query(`SELECT COUNT(*) AS n FROM events WHERE compressed = 1`).get() as any).n).toBe(BATCH_MIN);
  });
  test("abandoned session is swept, summarized", async () => {
    const { db, userRow } = setup();
    ingestEvents(db, MAP, userRow, mkEvents(3));
    db.run(`UPDATE sessions SET last_event_at = ?`, [Date.now() - ABANDON_MS - 1000]);
    const fake = new FakeProvider();
    fake.queue.push(OBS_JSON, SUM_JSON);
    const stats = await runCompressionPass(db, fake);
    expect((db.query(`SELECT ended_at FROM sessions`).get() as any).ended_at).not.toBeNull();
    expect(stats.summaries).toBe(1);
  });
  test("ended session with zero observations gets no summary", async () => {
    const { db, userRow } = setup();
    ingestEvents(db, MAP, userRow, mkEvents(1, "end"));
    const fake = new FakeProvider();
    fake.queue.push("[]");
    const stats = await runCompressionPass(db, fake);
    expect(stats.summaries).toBe(0);
    expect((db.query(`SELECT COUNT(*) AS n FROM summaries`).get() as any).n).toBe(0);
  });
});
