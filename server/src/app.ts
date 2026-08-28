import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Config } from "./config";
import type { UserRow } from "./db";
import { userByToken } from "./auth";
import { loadWorkspaces, REPO_KEY_RE } from "./projects";
import { ingestEvents } from "./ingest";
import { buildBriefing } from "./briefing";

export type AppEnv = { Variables: { user: UserRow } };

export function buildApp(db: Database, cfg: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const map = loadWorkspaces(cfg.workspacesPath);

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const user = userByToken(db, token);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    await next();
  });

  app.post("/ingest", async (c) => {
    const user = c.get("user");
    if (user.role === "service") return c.json({ error: "service tokens are read-only" }, 403);
    const text = await c.req.text();
    if (text.length > 262_144) return c.json({ error: "too large" }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return c.json({ error: "bad json" }, 400); }
    const events = (body as { events?: unknown[] })?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 200) {
      return c.json({ error: "events: array of 1..200 required" }, 400);
    }
    const r = ingestEvents(db, map, user, events);
    return c.json({ ok: true, ...r });
  });

  app.get("/context", (c) => {
    const repo = c.req.query("repo") ?? "";
    if (!REPO_KEY_RE.test(repo)) return c.text("bad repo", 400);
    const briefing = buildBriefing(db, c.get("user"), repo, map);
    return briefing ? c.text(briefing) : c.body(null, 204);
  });

  return app;
}
