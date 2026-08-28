import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { UserRow } from "./db";
import { REPO_KEY_RE, ensureProject } from "./projects";

export const eventSchema = z.object({
  kind: z.enum(["prompt", "tool", "end"]),
  session: z.string().min(8).max(64),
  repo: z.string().regex(REPO_KEY_RE),
  branch: z.string().max(200).optional(),
  ts: z.number().int().nonnegative(),
  text: z.string().max(8192).optional(),
  tool: z.string().max(200).optional(),
  input: z.string().max(8192).optional(),
  result: z.string().max(8192).optional(),
});
export type IngestEvent = z.infer<typeof eventSchema>;

export function ingestEvents(
  db: Database,
  map: Record<string, string[]>,
  user: UserRow,
  rawEvents: unknown[],
): { accepted: number; rejected: number } {
  let accepted = 0, rejected = 0;
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const raw of rawEvents) {
      const parsed = eventSchema.safeParse(raw);
      if (!parsed.success) { rejected++; continue; }
      const e = parsed.data;
      const project = ensureProject(db, e.repo, map);
      const session = db.query(`SELECT user_id FROM sessions WHERE id = ?`).get(e.session) as
        | { user_id: number } | null;
      if (session && session.user_id !== user.id) { rejected++; continue; }
      if (!session) {
        db.run(
          `INSERT INTO sessions(id, user_id, project_id, branch, started_at, last_event_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          [e.session, user.id, project.id, e.branch ?? null, now, now],
        );
      } else {
        db.run(
          `UPDATE sessions SET last_event_at = ?, branch = COALESCE(branch, ?)${e.kind === "end" ? ", ended_at = " + now : ""} WHERE id = ?`,
          [now, e.branch ?? null, e.session],
        );
      }
      db.run(
        `INSERT INTO events(session_id, user_id, project_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?, ?)`,
        [e.session, user.id, project.id, now, e.kind, JSON.stringify(e)],
      );
      accepted++;
    }
  });
  tx();
  return { accepted, rejected };
}
