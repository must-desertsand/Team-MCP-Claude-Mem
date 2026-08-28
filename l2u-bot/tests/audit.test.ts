import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/audit/log.js';
import type { AgentOutcome, Job } from '../src/types.js';

let dir: string;

const job: Job = {
  eventId: 'Ev123',
  channel: 'C1',
  threadTs: '1700000000.000100',
  userId: 'U1',
  text: 'review PR 12',
  receivedAt: 0,
};

const outcome: AgentOutcome = {
  text: 'Conclusion: no issues found',
  model: 'glm-5.2',
  turns: 3,
  toolCalls: [{ name: 'repo_grep', args: { pattern: 'x' }, ok: true, durationMs: 12, resultBytes: 40 }],
  stopReason: 'stop',
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2u-audit-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function readEntries(): any[] {
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('AuditLog', () => {
  it('writes the request and tool calls as one JSONL line', () => {
    new AuditLog(dir).record(job, outcome, 1234);
    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].eventId).toBe('Ev123');
    expect(entries[0].model).toBe('glm-5.2');
    expect(entries[0].toolCalls[0].name).toBe('repo_grep');
    expect(entries[0].durationMs).toBe(1234);
  });

  it('records failures too — it never goes silent', () => {
    new AuditLog(dir).recordFailure(job, 'All model candidates failed', 500);
    const entries = readEntries();
    expect(entries).toHaveLength(2);
    expect(entries[1].failure).toContain('All model candidates');
  });

  it('keeps each appended line independently parseable', () => {
    const log = new AuditLog(dir);
    log.record(job, outcome, 1);
    log.record(job, outcome, 2);
    expect(readEntries()).toHaveLength(4);
  });

  it('deletes logs past the retention window', () => {
    const log = new AuditLog(dir, 30);
    fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, '2020-06-01.jsonl'), '{}\n');
    const removed = log.prune(new Date('2020-06-15T00:00:00Z'));
    expect(removed).toContain('2020-01-01.jsonl');
    expect(removed).not.toContain('2020-06-01.jsonl');
    expect(fs.existsSync(path.join(dir, '2020-06-01.jsonl'))).toBe(true);
  });

  it('keeps everything when retention is disabled', () => {
    fs.writeFileSync(path.join(dir, '2019-01-01.jsonl'), '{}\n');
    expect(new AuditLog(dir, 0).prune(new Date('2025-01-01T00:00:00Z'))).toEqual([]);
    expect(fs.existsSync(path.join(dir, '2019-01-01.jsonl'))).toBe(true);
  });

  it('ignores files that are not dated logs', () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    new AuditLog(dir, 1).prune(new Date('2030-01-01T00:00:00Z'));
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });

  it('creates the audit directory owner-only', () => {
    const fresh = path.join(dir, 'nested');
    new AuditLog(fresh, 30);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
  });
});
