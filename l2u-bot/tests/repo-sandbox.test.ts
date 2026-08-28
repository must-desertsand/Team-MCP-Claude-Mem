import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInsideRoot, SandboxError } from '../src/repo/sandbox.js';

let root: string;
let outside: string;

beforeAll(() => {
  // macOS tmpdir is a /var -> /private/var symlink, so it must be realpath-normalized
  // for comparison against what the sandbox returns to hold.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l2u-sandbox-test-')));
  root = path.join(base, 'repo');
  outside = path.join(base, 'secret');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;');
  fs.writeFileSync(path.join(outside, 'creds.txt'), 'TOP SECRET');
  // A symlink inside the clone pointing outside it
  fs.symlinkSync(outside, path.join(root, 'escape'));
});

afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('resolveInsideRoot', () => {
  it('resolves a normal path inside the root to an absolute path', () => {
    expect(resolveInsideRoot(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
  });

  it('allows the root itself', () => {
    expect(resolveInsideRoot(root, '.')).toBe(root);
  });

  it('rejects parent-directory escapes', () => {
    expect(() => resolveInsideRoot(root, '../secret/creds.txt')).toThrow(SandboxError);
  });

  it('rejects nested .. escapes', () => {
    expect(() => resolveInsideRoot(root, 'src/../../secret/creds.txt')).toThrow(SandboxError);
  });

  it('rejects absolute path input', () => {
    expect(() => resolveInsideRoot(root, '/etc/passwd')).toThrow(SandboxError);
  });

  it('rejects escapes through a symlink', () => {
    expect(() => resolveInsideRoot(root, 'escape/creds.txt')).toThrow(SandboxError);
  });

  it('rejects access to the .git directory', () => {
    expect(() => resolveInsideRoot(root, '.git/config')).toThrow(SandboxError);
  });
});
