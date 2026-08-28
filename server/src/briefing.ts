import type { Database } from "bun:sqlite";
import type { UserRow } from "./db";
import { workspaceFor } from "./projects";

export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const WINDOW_MS = 72 * 3_600_000;
const MAX_ITEMS = 10;
const BUDGET = 6000;

export function buildBriefing(
  db: Database, user: UserRow, repoKey: string,
  map: Record<string, string[]>, now = Date.now(),
): string {
  const key = repoKey.toLowerCase();
  const ws = (db.query(`SELECT workspace FROM projects WHERE repo_key = ?`).get(key) as
    { workspace: string } | null)?.workspace ?? workspaceFor(key, map);

  const parts: string[] = [];
  const own = db.query(`
    SELECT su.body, su.open_threads, su.ts FROM summaries su
    JOIN projects p ON p.id = su.project_id
    WHERE su.user_id = ? AND p.repo_key = ? ORDER BY su.ts DESC LIMIT 1
  `).get(user.id, key) as { body: string; open_threads: string; ts: number } | null;
  if (own) {
    parts.push(`## Your last session here (${relTime(own.ts, now)})\n${own.body}` +
      (own.open_threads ? `\nOpen threads: ${own.open_threads}` : ""));
  }

  const sums = db.query(`
    SELECT su.ts, su.body, u.name, p.repo_key FROM summaries su
    JOIN users u ON u.id = su.user_id JOIN projects p ON p.id = su.project_id
    WHERE p.workspace = ? AND su.user_id != ? AND su.ts > ?
    ORDER BY su.ts DESC LIMIT ?
  `).all(ws, user.id, now - WINDOW_MS, MAX_ITEMS) as Array<{ ts: number; body: string; name: string; repo_key: string }>;
  const obs = db.query(`
    SELECT o.ts, o.type, o.title, u.name, p.repo_key FROM observations o
    JOIN users u ON u.id = o.user_id JOIN projects p ON p.id = o.project_id
    WHERE p.workspace = ? AND o.user_id != ? AND o.ts > ? AND o.type IN ('decision','bug')
    ORDER BY o.ts DESC LIMIT ?
  `).all(ws, user.id, now - WINDOW_MS, MAX_ITEMS) as Array<{ ts: number; type: string; title: string; name: string; repo_key: string }>;

  const items = [
    ...sums.map(s => ({ ts: s.ts, line: `- [${s.name} · ${s.repo_key} · ${relTime(s.ts, now)}] ${s.body.slice(0, 200)}` })),
    ...obs.map(o => ({ ts: o.ts, line: `- [${o.name} · ${o.repo_key} · ${relTime(o.ts, now)}] ${o.type}: ${o.title}` })),
  ].sort((a, b) => b.ts - a.ts).slice(0, MAX_ITEMS);
  if (items.length) {
    parts.push(`## Team activity — workspace "${ws}", last 72h\n${items.map(i => i.line).join("\n")}`);
  }

  if (parts.length === 0) return "";
  parts.push(`(team-mem: use team_search / team_status / team_timeline / team_get for more)`);
  const out = parts.join("\n\n");
  return out.length > BUDGET ? out.slice(0, BUDGET - 1) + "…" : out;
}
