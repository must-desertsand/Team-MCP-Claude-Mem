import type { Database } from "bun:sqlite";

const D7 = 7 * 86_400_000;
const D30 = 30 * 86_400_000;

export function runRetention(db: Database, now = Date.now()): { events: number; sessions: number } {
  let events = 0;
  events += db.run(`DELETE FROM events WHERE compressed = 1 AND ts < ?`, [now - D7]).changes;
  events += db.run(`DELETE FROM events WHERE compressed = -1 AND ts < ?`, [now - D30]).changes;
  const old = db.query(`
    SELECT id FROM sessions WHERE started_at < ?
      AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.session_id = sessions.id)
      AND NOT EXISTS (SELECT 1 FROM summaries su WHERE su.session_id = sessions.id)
  `).all(now - D30) as Array<{ id: string }>;
  for (const s of old) {
    events += db.run(`DELETE FROM events WHERE session_id = ?`, [s.id]).changes;
    db.run(`DELETE FROM sessions WHERE id = ?`, [s.id]);
  }
  return { events, sessions: old.length };
}

export function startRetentionLoop(db: Database, intervalMs = 6 * 3_600_000): () => void {
  const timer = setInterval(() => {
    try { runRetention(db); } catch (err) { console.error("[retention]", err); }
  }, intervalMs);
  return () => clearInterval(timer);
}
