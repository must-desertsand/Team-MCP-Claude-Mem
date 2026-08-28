import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
}

export class LockError extends Error {}

/** True when a process with this pid exists and we may signal it. */
export function isProcessAlive(pid: number, kill: (p: number, s: number) => void = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function parseLock(raw: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number') return undefined;
    return { pid: parsed.pid, host: parsed.host ?? 'unknown', startedAt: parsed.startedAt ?? 'unknown' };
  } catch {
    return undefined;
  }
}

/**
 * Single-instance lock.
 *
 * Slack routes each Socket Mode event to exactly one connection, so two running
 * instances split traffic unpredictably instead of duplicating it. That is worse
 * than a duplicate: the same question gets answered by whichever instance happened
 * to receive it, against whatever clone that machine has.
 *
 * This guards one machine. A second instance on another host cannot be detected
 * from here — that stays an operational rule.
 */
export class SingleInstanceLock {
  constructor(private readonly file: string) {}

  static defaultPath(): string {
    return path.resolve(process.cwd(), '.l2u-bot.lock');
  }

  /** Returns the holder when the lock is held by a live process, otherwise undefined. */
  inspect(): LockInfo | undefined {
    if (!fs.existsSync(this.file)) return undefined;
    const existing = parseLock(fs.readFileSync(this.file, 'utf8'));
    if (!existing) return undefined;
    if (existing.host !== os.hostname()) return existing;
    return isProcessAlive(existing.pid) ? existing : undefined;
  }

  acquire(): LockInfo {
    const holder = this.inspect();
    if (holder && holder.host === os.hostname()) {
      throw new LockError(
        `Another l2u-bot instance is already running on this machine (pid ${holder.pid}, since ${holder.startedAt}). ` +
          'Slack sends each event to exactly one connection, so running two splits traffic unpredictably. ' +
          `Stop the other process first, or remove ${this.file} if it is stale.`,
      );
    }

    const info: LockInfo = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.file, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
    return info;
  }

  release(): void {
    try {
      const existing = parseLock(fs.readFileSync(this.file, 'utf8'));
      // Only remove our own lock — never another process's.
      if (existing?.pid === process.pid) fs.unlinkSync(this.file);
    } catch {
      // Already gone.
    }
  }
}
