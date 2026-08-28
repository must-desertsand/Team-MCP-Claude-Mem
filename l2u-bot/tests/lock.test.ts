import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SingleInstanceLock, LockError, parseLock, isProcessAlive } from '../src/lock.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2u-lock-'));
  file = path.join(dir, '.l2u-bot.lock');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports a missing process as dead', () => {
    const kill = () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };
    expect(isProcessAlive(999_999, kill)).toBe(false);
  });

  it('treats EPERM as alive — the process exists under another user', () => {
    const kill = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    expect(isProcessAlive(1, kill)).toBe(true);
  });
});

describe('parseLock', () => {
  it('parses a well-formed lock', () => {
    expect(parseLock('{"pid":42,"host":"h","startedAt":"t"}')).toMatchObject({ pid: 42, host: 'h' });
  });

  it('returns undefined for malformed content', () => {
    expect(parseLock('not json')).toBeUndefined();
    expect(parseLock('{"host":"h"}')).toBeUndefined();
  });
});

describe('SingleInstanceLock', () => {
  it('acquires when no lock exists', () => {
    const info = new SingleInstanceLock(file).acquire();
    expect(info.pid).toBe(process.pid);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('writes the lock file readable only by its owner', () => {
    new SingleInstanceLock(file).acquire();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a second acquire while the holder is alive', () => {
    const lock = new SingleInstanceLock(file);
    lock.acquire();
    expect(() => lock.acquire()).toThrow(LockError);
  });

  it('explains why two instances are a problem', () => {
    const lock = new SingleInstanceLock(file);
    lock.acquire();
    expect(() => lock.acquire()).toThrow(/exactly one connection/);
  });

  it('takes over a stale lock left by a dead process', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: 999_999, host: os.hostname(), startedAt: 'earlier' }),
    );
    expect(() => new SingleInstanceLock(file).acquire()).not.toThrow();
  });

  it('takes over a lock written by a different host', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: 1, host: 'some-other-host', startedAt: 'earlier' }));
    expect(() => new SingleInstanceLock(file).acquire()).not.toThrow();
  });

  it('ignores a corrupted lock file', () => {
    fs.writeFileSync(file, 'garbage');
    expect(() => new SingleInstanceLock(file).acquire()).not.toThrow();
  });

  it('releases only its own lock', () => {
    const lock = new SingleInstanceLock(file);
    lock.acquire();
    lock.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not remove a lock held by another process', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: 12_345, host: os.hostname(), startedAt: 'x' }));
    new SingleInstanceLock(file).release();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('inspect reports the live holder', () => {
    new SingleInstanceLock(file).acquire();
    expect(new SingleInstanceLock(file).inspect()?.pid).toBe(process.pid);
  });

  it('inspect reports nothing when the lock is stale', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: 999_999, host: os.hostname(), startedAt: 'x' }));
    expect(new SingleInstanceLock(file).inspect()).toBeUndefined();
  });
});
