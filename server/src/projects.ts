import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";

export const REPO_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-_.]*\/[A-Za-z0-9-_.]+$/;

export function loadWorkspaces(path: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function workspaceFor(repoKey: string, map: Record<string, string[]>): string {
  const key = repoKey.toLowerCase();
  for (const [ws, repos] of Object.entries(map)) {
    if (repos.some(r => r.toLowerCase() === key)) return ws;
  }
  return key.split("/")[1] ?? key;
}

export function ensureProject(db: Database, repoKey: string, map: Record<string, string[]>) {
  const key = repoKey.toLowerCase();
  const existing = db.query(`SELECT id, workspace FROM projects WHERE repo_key = ?`).get(key) as
    | { id: number; workspace: string } | null;
  if (existing) return existing;
  const workspace = workspaceFor(key, map);
  const r = db.query(`INSERT INTO projects(repo_key, workspace, created_at) VALUES (?, ?, ?) RETURNING id`)
    .get(key, workspace, Date.now()) as { id: number };
  return { id: r.id, workspace };
}
