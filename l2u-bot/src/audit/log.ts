import fs from 'node:fs';
import path from 'node:path';
import type { AgentOutcome, Job } from '../types.js';

export interface AuditEntry {
  readonly at: string;
  readonly eventId: string;
  readonly channel: string;
  readonly userId: string;
  readonly question: string;
  readonly model: string;
  readonly turns: number;
  readonly stopReason: string;
  readonly toolCalls: unknown;
  readonly answerPreview: string;
  readonly durationMs: number;
}

/**
 * Append every request to JSONL. If nobody can retrace what the bot answered and
 * on what evidence, its judgements cannot be trusted.
 */
export class AuditLog {
  constructor(
    private readonly dir: string,
    private readonly retentionDays: number = 30,
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /**
   * Delete logs past the retention window.
   *
   * These files hold verbatim Slack conversations, so keeping them forever is
   * both a disk problem and a privacy one. Called at startup and once a day.
   */
  prune(now: Date = new Date()): string[] {
    if (this.retentionDays <= 0) return [];
    const cutoff = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60_000);
    const removed: string[] = [];

    for (const name of fs.readdirSync(this.dir)) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      const fileDate = new Date(`${match[1]}T00:00:00Z`);
      if (Number.isNaN(fileDate.getTime()) || fileDate >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(this.dir, name));
        removed.push(name);
      } catch {
        // A file we cannot remove is not worth failing startup over.
      }
    }
    return removed;
  }

  record(job: Job, outcome: AgentOutcome, durationMs: number): void {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      eventId: job.eventId,
      channel: job.channel,
      userId: job.userId,
      question: job.text,
      model: outcome.model,
      turns: outcome.turns,
      stopReason: outcome.stopReason,
      toolCalls: outcome.toolCalls,
      answerPreview: outcome.text.slice(0, 500),
      durationMs,
    };
    const file = path.join(this.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  recordFailure(job: Job, reason: string, durationMs: number): void {
    const file = path.join(this.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const entry = {
      at: new Date().toISOString(),
      eventId: job.eventId,
      channel: job.channel,
      userId: job.userId,
      question: job.text,
      failure: reason,
      durationMs,
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
