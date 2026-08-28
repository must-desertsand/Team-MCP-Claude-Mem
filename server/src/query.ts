import type { Database } from "bun:sqlite";
import type { UserRow } from "./db";
import { relTime } from "./briefing";

const ACTIVE_MS = 10 * 60 * 1000;

export interface StatusEntry {
  user: string;
  active: { repo: string; branch: string | null; minutesAgo: number } | null;
  recent: string[];
}

export function teamStatus(db: Database, opts: { workspace?: string; days?: number } = {}, now = Date.now()): StatusEntry[] {
  const since = now - (opts.days ?? 3) * 86_400_000;
  const users = db.query(`SELECT id, name FROM users WHERE role != 'service' ORDER BY name`)
    .all() as Array<{ id: number; name: string }>;
  return users.map(u => {
    const wsFilter = opts.workspace ? "AND p.workspace = ?" : "";
    const activeParams = opts.workspace ? [u.id, now - ACTIVE_MS, opts.workspace] : [u.id, now - ACTIVE_MS];
    const active = db.query(`
      SELECT p.repo_key, s.branch, s.last_event_at FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE s.user_id = ? AND s.ended_at IS NULL AND s.last_event_at > ? ${wsFilter}
      ORDER BY s.last_event_at DESC LIMIT 1
    `).get(...activeParams) as { repo_key: string; branch: string | null; last_event_at: number } | null;
    const recentParams = opts.workspace ? [u.id, since, opts.workspace] : [u.id, since];
    const recent = db.query(`
      SELECT su.ts, su.body, p.repo_key FROM summaries su JOIN projects p ON p.id = su.project_id
      WHERE su.user_id = ? AND su.ts > ? ${wsFilter}
      ORDER BY su.ts DESC LIMIT 3
    `).all(...recentParams) as Array<{ ts: number; body: string; repo_key: string }>;
    return {
      user: u.name,
      active: active ? {
        repo: active.repo_key, branch: active.branch,
        minutesAgo: Math.floor((now - active.last_event_at) / 60_000),
      } : null,
      recent: recent.map(r => `[${r.repo_key} · ${relTime(r.ts, now)}] ${r.body.slice(0, 160)}`),
    };
  });
}

export function ftsQuery(q: string): string {
  return q.split(/\s+/).filter(Boolean).slice(0, 8)
    .map(t => `"${t.replaceAll('"', "")}"`).filter(t => t !== '""').join(" ");
}

export interface SearchHit { id: string; ts: number; rel: string; user: string; repo: string; type: string; title: string; }

export function teamSearch(
  db: Database,
  opts: { query: string; workspace?: string; user?: string; type?: string; limit?: number },
  now = Date.now(),
): SearchHit[] {
  const q = ftsQuery(opts.query);
  if (!q) return [];
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const filters = `${opts.workspace ? "AND p.workspace = $ws" : ""} ${opts.user ? "AND u.name = $user" : ""}`;
  const base: Record<string, string> = { $q: q };
  if (opts.workspace) base.$ws = opts.workspace;
  if (opts.user) base.$user = opts.user;

  const obsRows = opts.type === "summary" ? [] : db.query(`
    SELECT o.id, o.ts, o.type, o.title, u.name AS user, p.repo_key AS repo
    FROM observations_fts f JOIN observations o ON o.id = f.rowid
    JOIN users u ON u.id = o.user_id JOIN projects p ON p.id = o.project_id
    WHERE observations_fts MATCH $q ${opts.type ? "AND o.type = $type" : ""} ${filters}
    ORDER BY o.ts DESC LIMIT ${limit}
  `).all(opts.type ? { ...base, $type: opts.type } : base) as Array<{ id: number; ts: number; type: string; title: string; user: string; repo: string }>;

  const sumRows = opts.type && opts.type !== "summary" ? [] : db.query(`
    SELECT su.id, su.ts, su.body, u.name AS user, p.repo_key AS repo
    FROM summaries_fts f JOIN summaries su ON su.id = f.rowid
    JOIN users u ON u.id = su.user_id JOIN projects p ON p.id = su.project_id
    WHERE summaries_fts MATCH $q ${filters}
    ORDER BY su.ts DESC LIMIT ${limit}
  `).all(base) as Array<{ id: number; ts: number; body: string; user: string; repo: string }>;

  return [
    ...obsRows.map(r => ({ id: `o${r.id}`, ts: r.ts, rel: relTime(r.ts, now), user: r.user, repo: r.repo, type: r.type, title: r.title })),
    ...sumRows.map(r => ({ id: `s${r.id}`, ts: r.ts, rel: relTime(r.ts, now), user: r.user, repo: r.repo, type: "summary", title: r.body.slice(0, 100) })),
  ].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export interface TimelineItem { id: string; ts: number; rel: string; user: string; type: string; title: string; anchor: boolean; }

export function teamTimeline(
  db: Database,
  opts: { anchorId?: string; sessionId?: string; before?: number; after?: number },
  now = Date.now(),
): TimelineItem[] {
  const before = opts.before ?? 5, after = opts.after ?? 5;
  let sessionId = opts.sessionId ?? null;
  const anchorId = opts.anchorId ?? null;
  if (anchorId) {
    const n = Number(anchorId.slice(1));
    if (!Number.isFinite(n)) return [];
    const row = anchorId.startsWith("o")
      ? db.query(`SELECT session_id FROM observations WHERE id = ?`).get(n) as { session_id: string } | null
      : db.query(`SELECT session_id FROM summaries WHERE id = ?`).get(n) as { session_id: string } | null;
    if (!row) return [];
    sessionId = sessionId ?? row.session_id;
  }
  if (!sessionId) return [];
  const rows = db.query(`
    SELECT o.id, o.ts, o.type, o.title, u.name AS user FROM observations o
    JOIN users u ON u.id = o.user_id WHERE o.session_id = ? ORDER BY o.id
  `).all(sessionId) as Array<{ id: number; ts: number; type: string; title: string; user: string }>;
  const items = rows.map(r => ({
    id: `o${r.id}`, ts: r.ts, rel: relTime(r.ts, now), user: r.user, type: r.type, title: r.title,
    anchor: `o${r.id}` === anchorId,
  }));
  const idx = items.findIndex(i => i.anchor);
  if (idx < 0) return items.slice(0, before + after + 1);
  return items.slice(Math.max(0, idx - before), idx + after + 1);
}

export interface FullItem {
  id: string; ts: number; user: string; repo: string; session: string; type: string;
  title: string; body: string; files: string[]; tags: string[]; open_threads?: string;
}

export function teamGet(db: Database, ids: string[]): FullItem[] {
  const out: FullItem[] = [];
  for (const id of ids.slice(0, 10)) {
    const n = Number(id.slice(1));
    if (!Number.isFinite(n)) continue;
    if (id.startsWith("o")) {
      const r = db.query(`
        SELECT o.*, u.name AS user, p.repo_key AS repo FROM observations o
        JOIN users u ON u.id = o.user_id JOIN projects p ON p.id = o.project_id WHERE o.id = ?
      `).get(n) as any;
      if (r) out.push({ id, ts: r.ts, user: r.user, repo: r.repo, session: r.session_id, type: r.type,
        title: r.title, body: r.body, files: JSON.parse(r.files), tags: JSON.parse(r.tags) });
    } else if (id.startsWith("s")) {
      const r = db.query(`
        SELECT su.*, u.name AS user, p.repo_key AS repo FROM summaries su
        JOIN users u ON u.id = su.user_id JOIN projects p ON p.id = su.project_id WHERE su.id = ?
      `).get(n) as any;
      if (r) out.push({ id, ts: r.ts, user: r.user, repo: r.repo, session: r.session_id, type: "summary",
        title: r.body.slice(0, 100), body: r.body, files: [], tags: [], open_threads: r.open_threads });
    }
  }
  return out;
}

export function deleteSession(db: Database, sessionId: string, requester: UserRow): "deleted" | "forbidden" | "not_found" {
  const s = db.query(`SELECT user_id FROM sessions WHERE id = ?`).get(sessionId) as { user_id: number } | null;
  if (!s) return "not_found";
  if (requester.role === "service") return "forbidden";
  if (requester.role !== "admin" && s.user_id !== requester.id) return "forbidden";
  const tx = db.transaction(() => {
    db.run(`DELETE FROM events WHERE session_id = ?`, [sessionId]);
    db.run(`DELETE FROM observations WHERE session_id = ?`, [sessionId]);
    db.run(`DELETE FROM summaries WHERE session_id = ?`, [sessionId]);
    db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
  });
  tx();
  return "deleted";
}
