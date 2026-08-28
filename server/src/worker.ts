import type { Database } from "bun:sqlite";
import type { EventRow, ObservationRow, SessionRow } from "./db";
import type { LlmProvider } from "./provider";
import { extractionPrompt, summaryPrompt, extractJson, obsDraftSchema, summaryDraftSchema } from "./prompts";

export const BATCH_MIN = 20;
export const BATCH_MAX = 40;
export const ABANDON_MS = 30 * 60 * 1000;
export const MAX_ATTEMPTS = 3;

export interface CompressStats { observations: number; summaries: number; parked: number; }

export async function runCompressionPass(db: Database, provider: LlmProvider, now = Date.now()): Promise<CompressStats> {
  const stats: CompressStats = { observations: 0, summaries: 0, parked: 0 };

  db.run(`UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL AND last_event_at < ?`, [now, now - ABANDON_MS]);

  const candidates = db.query(`
    SELECT s.*, COUNT(e.id) AS pending FROM sessions s
    JOIN events e ON e.session_id = s.id AND e.compressed = 0
    GROUP BY s.id HAVING pending >= ? OR s.ended_at IS NOT NULL
  `).all(BATCH_MIN) as Array<SessionRow & { pending: number }>;

  for (const session of candidates) {
    const events = db.query(
      `SELECT * FROM events WHERE session_id = ? AND compressed = 0 ORDER BY id LIMIT ?`,
    ).all(session.id, BATCH_MAX) as EventRow[];
    if (events.length === 0) continue;
    const ids = events.map(e => e.id);
    const marks = ids.map(() => "?").join(",");
    const { system, user } = extractionPrompt(events);
    let raw: string | null = null;
    try { raw = await provider.complete(system, user); } catch { raw = null; }
    const parsed = obsDraftSchema.safeParse(raw === null ? null : extractJson(raw));
    if (!parsed.success) {
      db.run(`UPDATE events SET attempts = attempts + 1 WHERE id IN (${marks})`, ids);
      const parked = db.run(
        `UPDATE events SET compressed = -1 WHERE compressed = 0 AND attempts >= ? AND id IN (${marks})`,
        [MAX_ATTEMPTS, ...ids],
      );
      stats.parked += parked.changes;
      continue;
    }
    const tx = db.transaction(() => {
      for (const d of parsed.data) {
        db.run(
          `INSERT INTO observations(session_id, user_id, project_id, ts, type, title, body, files, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [session.id, session.user_id, session.project_id, now, d.type, d.title, d.body,
           JSON.stringify(d.files), JSON.stringify(d.tags)],
        );
        stats.observations++;
      }
      db.run(`UPDATE events SET compressed = 1 WHERE id IN (${marks})`, ids);
    });
    tx();
  }

  const needSummary = db.query(`
    SELECT s.* FROM sessions s
    WHERE s.ended_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM summaries su WHERE su.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.compressed = 0)
      AND EXISTS (SELECT 1 FROM observations o WHERE o.session_id = s.id)
  `).all() as SessionRow[];

  for (const session of needSummary) {
    const obs = db.query(`SELECT * FROM observations WHERE session_id = ? ORDER BY id`).all(session.id) as ObservationRow[];
    const lastEvents = (db.query(`SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 5`)
      .all(session.id) as EventRow[]).reverse();
    const { system, user } = summaryPrompt(obs, lastEvents);
    let raw: string | null = null;
    try { raw = await provider.complete(system, user); } catch { raw = null; }
    const parsed = summaryDraftSchema.safeParse(raw === null ? null : extractJson(raw));
    if (!parsed.success) continue; // retried on a later pass
    db.run(
      `INSERT INTO summaries(session_id, user_id, project_id, ts, body, open_threads) VALUES (?, ?, ?, ?, ?, ?)`,
      [session.id, session.user_id, session.project_id, now, parsed.data.body, parsed.data.open_threads],
    );
    stats.summaries++;
  }
  return stats;
}

export function startCompressionLoop(db: Database, provider: LlmProvider, pollMs: number): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runCompressionPass(db, provider); } catch (err) { console.error("[compress]", err); }
    running = false;
  }, pollMs);
  return () => clearInterval(timer);
}
