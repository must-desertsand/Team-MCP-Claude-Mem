import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { AppEnv } from "./app";
import { teamStatus, teamSearch, deleteSession } from "./query";

// Parses a query-string number param, discarding anything that isn't finite
// (missing, "", or non-numeric) so malformed input falls back to the callee's
// own default instead of propagating NaN into SQL (string-interpolated LIMIT
// clauses in particular throw a raw SQLiteError, and bound NaN params
// silently make ts > ? comparisons always false).
function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function registerRestRoutes(app: Hono<AppEnv>, db: Database) {
  app.get("/api/status", (c) => c.json(teamStatus(db, {
    workspace: c.req.query("workspace") || undefined,
    days: num(c.req.query("days")),
  })));

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q) return c.json({ error: "q required" }, 400);
    return c.json(teamSearch(db, {
      query: q,
      workspace: c.req.query("workspace") || undefined,
      user: c.req.query("user") || undefined,
      type: c.req.query("type") || undefined,
      limit: num(c.req.query("limit")),
    }));
  });

  app.get("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = db.query(`
      SELECT s.*, u.name AS user, p.repo_key AS repo FROM sessions s
      JOIN users u ON u.id = s.user_id JOIN projects p ON p.id = s.project_id WHERE s.id = ?
    `).get(id);
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json({
      session,
      observations: db.query(`SELECT * FROM observations WHERE session_id = ? ORDER BY id`).all(id),
      summary: db.query(`SELECT * FROM summaries WHERE session_id = ?`).get(id) ?? null,
    });
  });

  app.delete("/api/sessions/:id", (c) => {
    const r = deleteSession(db, c.req.param("id"), c.get("user"));
    if (r === "deleted") return c.json({ ok: true });
    return c.json({ error: r }, r === "forbidden" ? 403 : 404);
  });
}
