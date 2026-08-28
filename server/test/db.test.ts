import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";

function seed(db: ReturnType<typeof openDb>) {
  db.run(`INSERT INTO users(name, role, token_hash, created_at) VALUES ('h','member','x',1)`);
  db.run(`INSERT INTO projects(repo_key, workspace, created_at) VALUES ('mustfintech/web','l2u',1)`);
  db.run(`INSERT INTO sessions(id, user_id, project_id, started_at, last_event_at) VALUES ('s1',1,1,1,1)`);
}

describe("openDb", () => {
  test("creates schema idempotently with WAL", () => {
    const db = openDb(":memory:");
    openDb(":memory:"); // second open must not throw
    const tables = db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
    const names = tables.map(t => t.name);
    for (const t of ["users", "projects", "sessions", "events", "observations", "summaries"]) {
      expect(names).toContain(t);
    }
  });
  test("FTS index follows insert, update, delete", () => {
    const db = openDb(":memory:");
    seed(db);
    db.run(`INSERT INTO observations(session_id,user_id,project_id,ts,type,title,body,files,tags)
            VALUES ('s1',1,1,5,'decision','use JWT auth','we chose tokens','[]','[]')`);
    const hit = () => db.query(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"JWT"'`).all();
    expect(hit().length).toBe(1);
    db.run(`UPDATE observations SET title='use cookie auth' WHERE id=1`);
    expect(hit().length).toBe(0);
    expect(db.query(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"cookie"'`).all().length).toBe(1);
    db.run(`DELETE FROM observations WHERE id=1`);
    expect(db.query(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"cookie"'`).all().length).toBe(0);
  });
  test("summaries FTS works", () => {
    const db = openDb(":memory:");
    seed(db);
    db.run(`INSERT INTO summaries(session_id,user_id,project_id,ts,body,open_threads)
            VALUES ('s1',1,1,5,'refactored the login flow','')`);
    expect(db.query(`SELECT rowid FROM summaries_fts WHERE summaries_fts MATCH '"login"'`).all().length).toBe(1);
  });
});
