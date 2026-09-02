import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { UserRow } from "./db";
import { REPO_KEY_RE, ensureProject } from "./projects";
import { redact } from "./redact";

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
      // Defense in depth: conforming clients redact before sending, but a stale
      // or non-conforming client must not be able to put raw secrets in the store.
      const e = { ...parsed.data };
      if (e.text) e.text = redact(e.text);
      if (e.input) e.input = redact(e.input);
      if (e.result) e.result = redact(e.result);
      try {
        const project = ensureProject(db, e.repo, map);
        const session = db.query(`SELECT user_id, ended_at FROM sessions WHERE id = ?`).get(e.session) as
          | { user_id: number; ended_at: number | null } | null;
        if (session && session.user_id !== user.id) { rejected++; continue; }
        const endedAt = e.kind === "end" ? now : null;
        if (!session) {
          db.run(
            `INSERT INTO sessions(id, user_id, project_id, branch, started_at, last_event_at, ended_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [e.session, user.id, project.id, e.branch ?? null, now, now, endedAt],
          );
        } else {
          // Non-end activity on a previously-ended session means it resumed: clear ended_at
          // (rather than preserving it via COALESCE) so the abandoned/end sweep re-evaluates it.
          db.run(
            `UPDATE sessions SET last_event_at = ?, branch = COALESCE(branch, ?), ended_at = ? WHERE id = ?`,
            [now, e.branch ?? null, endedAt, e.session],
          );
          // The resumed session's old summary is now stale (it didn't see this new activity);
          // delete it (plain DELETE so the FTS trigger fires) so the worker regenerates it from
          // ALL the session's observations at the next true end.
          if (e.kind !== "end" && session.ended_at !== null) {
            db.run(`DELETE FROM summaries WHERE session_id = ?`, [e.session]);
          }
        }
        db.run(
          `INSERT INTO events(session_id, user_id, project_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?, ?)`,
          [e.session, user.id, project.id, now, e.kind, JSON.stringify(e)],
        );
        accepted++;
      } catch {
        rejected++;
      }
    }
  });
  tx();
  return { accepted, rejected };
}
