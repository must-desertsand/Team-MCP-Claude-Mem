import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createUser } from "../src/auth";
import { ensureProject } from "../src/projects";
import { ftsQuery, teamStatus, teamSearch, teamTimeline, teamGet, deleteSession } from "../src/query";
import { buildApp } from "../src/app";
import type { Config } from "../src/config";

const MAP = { l2u: ["mustfintech/web", "mustfintech/app"] };
const NOW = 1_800_000_000_000;

function seed() {
  const db = openDb(":memory:");
  const h = createUser(db, "haseeb");
  const y = createUser(db, "yameen");
  const svc = createUser(db, "l2u-work", "service");
  const adm = createUser(db, "hoyoung", "admin");
  const web = ensureProject(db, "mustfintech/web", MAP);
  db.run(`INSERT INTO sessions(id,user_id,project_id,branch,started_at,last_event_at) VALUES ('s-h',?,?,'main',?,?)`,
    [h.id, web.id, NOW - 3_600_000, NOW - 120_000]);
  db.run(`INSERT INTO observations(session_id,user_id,project_id,ts,type,title,body,files,tags)
          VALUES ('s-h',?,?,?,?,?,?,?,?)`,
    [h.id, web.id, NOW - 300_000, "decision", "moved auth to JWT", "we now sign tokens", '["src/auth.ts"]', '["auth"]']);
  db.run(`INSERT INTO observations(session_id,user_id,project_id,ts,type,title,body)
          VALUES ('s-h',?,?,?,?,?,?)`, [h.id, web.id, NOW - 200_000, "bug", "login 500 fixed", "validator added"]);
  db.run(`INSERT INTO summaries(session_id,user_id,project_id,ts,body,open_threads)
          VALUES ('s-h',?,?,?,?,?)`, [h.id, web.id, NOW - 100_000, "auth work done today", "docs pending"]);
  return { db, h, y, svc, adm, web };
}
const asRow = (u: { id: number; name: string; role: string }) =>
  ({ id: u.id, name: u.name, role: u.role, token_hash: "", created_at: 0 }) as any;

describe("ftsQuery", () => {
  test("quotes tokens and strips dangerous chars", () => {
    expect(ftsQuery("auth flow")).toBe('"auth" "flow"');
    expect(ftsQuery('injection" OR x')).toBe('"injection" "OR" "x"');
    expect(ftsQuery("")).toBe("");
  });
});

describe("teamStatus", () => {
  test("shows active session and recent summaries; hides service users", () => {
    const { db } = seed();
    const s = teamStatus(db, {}, NOW);
    expect(s.map(e => e.user)).toEqual(["haseeb", "hoyoung", "yameen"]);
    const h = s.find(e => e.user === "haseeb")!;
    expect(h.active).toEqual({ repo: "mustfintech/web", branch: "main", minutesAgo: 2 });
    expect(h.recent[0]).toContain("auth work done today");
    expect(s.find(e => e.user === "yameen")!.active).toBeNull();
  });
});

describe("teamStatus fallback", () => {
  test("shows latest observations when a user has no summary yet", () => {
    const db = openDb(":memory:");
    const y = createUser(db, "yameen");
    const web = ensureProject(db, "mustfintech/web", MAP);
    db.run(`INSERT INTO sessions(id,user_id,project_id,started_at,last_event_at) VALUES ('s-y',?,?,?,?)`, [y.id, web.id, NOW - 60_000, NOW - 60_000]);
    db.run(`INSERT INTO observations(session_id,user_id,project_id,ts,type,title,body) VALUES ('s-y',?,?,?,?,?,?)`,
      [y.id, web.id, NOW - 30_000, "change", "switched login to session envelope", "b"]);
    const entry = teamStatus(db, {}, NOW).find(e => e.user === "yameen")!;
    expect(entry.recent[0]).toContain("change: switched login to session envelope");
  });
});

describe("teamSearch / teamTimeline / teamGet", () => {
  test("search returns compact hits across observations and summaries", () => {
    const { db } = seed();
    const hits = teamSearch(db, { query: "auth" }, NOW);
    expect(hits.length).toBe(2); // obs "moved auth to JWT" + summary "auth work done today"
    expect(hits[0].ts).toBeGreaterThan(hits[1].ts);
    expect(hits.some(x => x.id.startsWith("o"))).toBe(true);
    expect(hits.some(x => x.id.startsWith("s"))).toBe(true);
  });
  test("filters by user and type", () => {
    const { db } = seed();
    expect(teamSearch(db, { query: "auth", user: "yameen" }, NOW).length).toBe(0);
    expect(teamSearch(db, { query: "auth", type: "summary" }, NOW).every(h => h.type === "summary")).toBe(true);
  });
  test("timeline walks a session around an anchor", () => {
    const { db } = seed();
    const anchor = teamSearch(db, { query: "JWT" }, NOW)[0];
    const tl = teamTimeline(db, { anchorId: anchor.id }, NOW);
    expect(tl.length).toBe(2);
    expect(tl.find(i => i.anchor)!.title).toBe("moved auth to JWT");
  });
  test("get returns full bodies for mixed ids, caps at 10, skips unknown", () => {
    const { db } = seed();
    const full = teamGet(db, ["o1", "s1", "o999", "bad"]);
    expect(full.length).toBe(2);
    expect(full[0].body).toBe("we now sign tokens");
    expect(full[0].files).toEqual(["src/auth.ts"]);
    expect(full[1].open_threads).toBe("docs pending");
  });
});

describe("deleteSession", () => {
  test("member deletes own, not others; service never; admin any; 404 unknown", () => {
    const { db, h, y, svc, adm } = seed();
    expect(deleteSession(db, "s-h", asRow(y))).toBe("forbidden");
    expect(deleteSession(db, "s-h", asRow(svc))).toBe("forbidden");
    expect(deleteSession(db, "nope", asRow(h))).toBe("not_found");
    expect(deleteSession(db, "s-h", asRow(h))).toBe("deleted");
    expect((db.query(`SELECT COUNT(*) AS n FROM observations`).get() as any).n).toBe(0);
    expect((db.query(`SELECT COUNT(*) AS n FROM summaries`).get() as any).n).toBe(0);
    const again = seed();
    expect(deleteSession(again.db, "s-h", asRow(again.adm))).toBe("deleted");
  });
});

describe("REST", () => {
  const CFG: Config = { port: 0, dbPath: ":memory:", llmBaseUrl: "", llmApiKey: "", llmModel: "",
    llmMaxConcurrent: 1, pollMs: 999999, workspacesPath: "/nonexistent.json" };
  test("status, search, session detail, delete auth matrix", async () => {
    const { db, h, svc } = seed();
    const app = buildApp(db, CFG);
    const get = (p: string, t: string) => app.request(p, { headers: { authorization: `Bearer ${t}` } });
    expect((await get("/api/status", svc.token)).status).toBe(200);
    const search = (await (await get("/api/search?q=auth", svc.token)).json()) as any[];
    expect(search.length).toBe(2);
    expect((await get("/api/search", svc.token)).status).toBe(400);
    const detail = (await (await get("/api/sessions/s-h", svc.token)).json()) as any;
    expect(detail.observations.length).toBe(2);
    const del = (t: string) => app.request("/api/sessions/s-h", { method: "DELETE", headers: { authorization: `Bearer ${t}` } });
    expect((await del(svc.token)).status).toBe(403);
    expect((await del(h.token)).status).toBe(200);
  });
  test("tolerates malformed numeric query params instead of erroring", async () => {
    const { db, svc } = seed();
    const app = buildApp(db, CFG);
    const get = (p: string, t: string) => app.request(p, { headers: { authorization: `Bearer ${t}` } });

    const search = await get("/api/search?q=auth&limit=notanumber", svc.token);
    expect(search.status).toBe(200);
    expect(((await search.json()) as any[]).length).toBe(2);

    const status = await get("/api/status?days=notanumber", svc.token);
    expect(status.status).toBe(200);
    const body = (await status.json()) as any[];
    expect(body.map((e: any) => e.user)).toEqual(["haseeb", "hoyoung", "yameen"]);
    expect(body.find((e: any) => e.user === "haseeb").recent[0]).toContain("auth work done today");
  });
});
