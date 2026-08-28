import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createUser } from "../src/auth";
import { ensureProject } from "../src/projects";
import { runRetention } from "../src/retention";

const NOW = 1_800_000_000_000;
const D = 86_400_000;

function seed() {
  const db = openDb(":memory:");
  const u = createUser(db, "h");
  const p = ensureProject(db, "mustfintech/web", {});
  const addSession = (id: string, startedAgoDays: number) =>
    db.run(`INSERT INTO sessions(id,user_id,project_id,started_at,last_event_at) VALUES (?,?,?,?,?)`,
      [id, u.id, p.id, NOW - startedAgoDays * D, NOW - startedAgoDays * D]);
  const addEvent = (session: string, compressed: number, agoDays: number) =>
    db.run(`INSERT INTO events(session_id,user_id,project_id,ts,kind,payload,compressed) VALUES (?,?,?,?,'tool','{}',?)`,
      [session, u.id, p.id, NOW - agoDays * D, compressed]);
  return { db, u, p, addSession, addEvent };
}

describe("runRetention", () => {
  test("prunes compressed events after 7d, parked after 30d, keeps fresh and pending", () => {
    const { db, addSession, addEvent } = seed();
    addSession("s1", 40);
    addEvent("s1", 1, 8);   // compressed, old -> pruned
    addEvent("s1", 1, 2);   // compressed, fresh -> kept
    addEvent("s1", -1, 31); // parked, old -> pruned
    addEvent("s1", -1, 8);  // parked, fresh -> kept
    addEvent("s1", 0, 100); // pending -> always kept
    db.run(`INSERT INTO observations(session_id,user_id,project_id,ts,type,title,body) VALUES ('s1',1,1,1,'bug','t','b')`);
    const r = runRetention(db, NOW);
    expect(r.events).toBe(2);
    expect((db.query(`SELECT COUNT(*) AS n FROM events`).get() as any).n).toBe(3);
  });
  test("prunes observation-less sessions after 30d, keeps ones with knowledge", () => {
    const { db, addSession, addEvent } = seed();
    addSession("s-empty", 31);
    addEvent("s-empty", 1, 31);
    addSession("s-kept", 31);
    db.run(`INSERT INTO summaries(session_id,user_id,project_id,ts,body) VALUES ('s-kept',1,1,1,'did things')`);
    addSession("s-young", 2);
    const r = runRetention(db, NOW);
    expect(r.sessions).toBe(1);
    const left = (db.query(`SELECT id FROM sessions ORDER BY id`).all() as any[]).map(s => s.id);
    expect(left).toEqual(["s-kept", "s-young"]);
    expect((db.query(`SELECT COUNT(*) AS n FROM events WHERE session_id='s-empty'`).get() as any).n).toBe(0);
  });
});
