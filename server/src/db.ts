import { Database } from "bun:sqlite";

export interface UserRow { id: number; name: string; role: "member" | "service" | "admin"; token_hash: string; created_at: number; }
export interface ProjectRow { id: number; repo_key: string; workspace: string; created_at: number; }
export interface SessionRow { id: string; user_id: number; project_id: number; branch: string | null; started_at: number; last_event_at: number; ended_at: number | null; }
export interface EventRow { id: number; session_id: string; user_id: number; project_id: number; ts: number; kind: string; payload: string; compressed: number; attempts: number; }
export interface ObservationRow { id: number; session_id: string; user_id: number; project_id: number; ts: number; type: string; title: string; body: string; files: string; tags: string; }
export interface SummaryRow { id: number; session_id: string; user_id: number; project_id: number; ts: number; body: string; open_threads: string; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY, repo_key TEXT UNIQUE NOT NULL, workspace TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
  branch TEXT, started_at INTEGER NOT NULL, last_event_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
  ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS observations(
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
  ts INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS summaries(
  id INTEGER PRIMARY KEY, session_id TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
  ts INTEGER NOT NULL, body TEXT NOT NULL, open_threads TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, compressed);
CREATE INDEX IF NOT EXISTS idx_obs_proj_ts ON observations(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_sum_proj_ts ON summaries(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_sessions_proj ON sessions(project_id, last_event_at);
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(title, body, tags, content='observations', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(body, open_threads, content='summaries', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO observations_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS sum_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, body, open_threads) VALUES (new.id, new.body, new.open_threads);
END;
CREATE TRIGGER IF NOT EXISTS sum_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, body, open_threads) VALUES ('delete', old.id, old.body, old.open_threads);
END;
CREATE TRIGGER IF NOT EXISTS sum_au AFTER UPDATE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, body, open_threads) VALUES ('delete', old.id, old.body, old.open_threads);
  INSERT INTO summaries_fts(rowid, body, open_threads) VALUES (new.id, new.body, new.open_threads);
END;
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA);
  return db;
}
