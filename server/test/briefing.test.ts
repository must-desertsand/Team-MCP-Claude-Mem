import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createUser } from "../src/auth";
import { ensureProject } from "../src/projects";
import { relTime, buildBriefing } from "../src/briefing";
import { buildApp } from "../src/app";
import type { Config } from "../src/config";

const MAP = { l2u: ["mustfintech/web", "mustfintech/app"] };
const NOW = 1_800_000_000_000;

function seed() {
  const db = openDb(":memory:");
  const me = createUser(db, "haseeb");
  const mate = createUser(db, "yameen");
  const web = ensureProject(db, "mustfintech/web", MAP);
  const app = ensureProject(db, "mustfintech/app", MAP);
  const meRow = { id: me.id, name: "haseeb", role: "member", token_hash: "", created_at: 0 } as any;
  return { db, me, mate, web, app, meRow };
}
const addSession = (db: any, id: string, userId: number, projectId: number) =>
  db.run(`INSERT INTO sessions(id,user_id,project_id,started_at,last_event_at) VALUES (?,?,?,?,?)`, [id, userId, projectId, NOW, NOW]);

describe("relTime", () => {
  test("buckets", () => {
    expect(relTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe("5 m ago");
    expect(relTime(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(relTime(NOW - 50 * 3_600_000, NOW)).toBe("2 d ago");
  });
});

describe("buildBriefing", () => {
  test("empty when no data", () => {
    const { db, meRow } = seed();
    expect(buildBriefing(db, meRow, "mustfintech/web", MAP, NOW)).toBe("");
  });
  test("includes own last summary and teammates' workspace activity, excludes own", () => {
    const { db, me, mate, web, app, meRow } = seed();
    addSession(db, "s-me", me.id, web.id);
    addSession(db, "s-mate", mate.id, app.id);
    db.run(`INSERT INTO summaries(session_id,user_id,project_id,ts,body,open_threads)
            VALUES ('s-me',?,?,?,?,?)`, [me.id, web.id, NOW - 3_600_000, "I refactored ingest", "tests pending"]);
    db.run(`INSERT INTO summaries(session_id,user_id,project_id,ts,body,open_threads)
            VALUES ('s-mate',?,?,?,?,?)`, [mate.id, app.id, NOW - 7_200_000, "Switched auth response shape", ""]);
    db.run(`INSERT INTO observations(session_id,user_id,project_id,ts,type,title,body)
            VALUES ('s-mate',?,?,?,?,?,?)`, [mate.id, app.id, NOW - 60_000, "decision", "renamed /login to /auth/session", "b"]);
    const out = buildBriefing(db, meRow, "mustfintech/web", MAP, NOW);
    expect(out).toContain("Your last session here (1 h ago)");
    expect(out).toContain("I refactored ingest");
    expect(out).toContain("Open threads: tests pending");
    expect(out).toContain("yameen");
    expect(out).toContain("Switched auth response shape");
    expect(out).toContain("decision: renamed /login to /auth/session");
    expect(out).toContain("team_search");
    // own summary must not appear again under team activity
    expect(out.indexOf("I refactored ingest")).toBe(out.lastIndexOf("I refactored ingest"));
  });
  test("stays within the 6000-char budget", () => {
    const { db, mate, app, meRow } = seed();
    for (let i = 0; i < 12; i++) {
      addSession(db, `s-${i}`, mate.id, app.id);
      db.run(`INSERT INTO summaries(session_id,user_id,project_id,ts,body,open_threads)
              VALUES (?,?,?,?,?, '')`, [`s-${i}`, mate.id, app.id, NOW - i * 1000, "x".repeat(3000)]);
    }
    const out = buildBriefing(db, meRow, "mustfintech/web", MAP, NOW);
    expect(out.length).toBeLessThanOrEqual(6000);
  });
  test("72h window excludes old items", () => {
    const { db, mate, app, meRow } = seed();
    addSession(db, "s-old", mate.id, app.id);
    db.run(`INSERT INTO summaries(session_id,user_id,project_id,ts,body,open_threads)
            VALUES ('s-old',?,?,?,?, '')`, [mate.id, app.id, NOW - 80 * 3_600_000, "ancient work"]);
    expect(buildBriefing(db, meRow, "mustfintech/web", MAP, NOW)).toBe("");
  });
});

test("GET /context returns text or 204", async () => {
  const db = openDb(":memory:");
  const me = createUser(db, "haseeb");
  const cfg: Config = { port: 0, dbPath: ":memory:", llmBaseUrl: "", llmApiKey: "", llmModel: "",
    llmMaxConcurrent: 1, pollMs: 999999, workspacesPath: "/nonexistent.json" };
  const app = buildApp(db, cfg);
  const auth = { authorization: `Bearer ${me.token}` };
  expect((await app.request("/context?repo=mustfintech/web", { headers: auth })).status).toBe(204);
  expect((await app.request("/context?repo=bad", { headers: auth })).status).toBe(400);
});

test("GET /context returns 200 with the briefing body when there is one", async () => {
  const { db, me, mate, app: appProj } = seed();
  const real = Date.now();
  addSession(db, "s-mate", mate.id, appProj.id);
  db.run(`INSERT INTO summaries(session_id,user_id,project_id,ts,body,open_threads)
          VALUES ('s-mate',?,?,?,?,?)`, [mate.id, appProj.id, real - 3_600_000, "Shipped the thing", ""]);
  const cfg: Config = { port: 0, dbPath: ":memory:", llmBaseUrl: "", llmApiKey: "", llmModel: "",
    llmMaxConcurrent: 1, pollMs: 999999, workspacesPath: "/nonexistent.json" };
  const app = buildApp(db, cfg);
  const auth = { authorization: `Bearer ${me.token}` };
  const res = await app.request("/context?repo=mustfintech/web", { headers: auth });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Shipped the thing");
});
