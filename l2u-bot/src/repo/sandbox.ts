import fs from 'node:fs';
import path from 'node:path';

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** Directories the model must never reach. */
const DENIED_SEGMENTS = new Set(['.git', 'node_modules', '.env']);

/**
 * Resolve symlinks up to the nearest existing ancestor so paths that do not
 * exist yet still work. This is what catches symlinks pointing outside the root.
 */
function realpathOfNearestExisting(target: string): string {
  let current = target;
  for (;;) {
    try {
      const resolved = fs.realpathSync(current);
      return current === target ? resolved : path.join(resolved, path.relative(current, target));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      current = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root + path.sep);
}

/**
 * Resolve a path that must stay inside the clone root.
 * Rejects absolute paths, `..` escapes, symlink escapes, and sensitive directories.
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new SandboxError('Path is empty.');
  }
  if (path.isAbsolute(relativePath)) {
    throw new SandboxError(`Absolute paths are not allowed: ${relativePath}`);
  }

  const normalizedRoot = realpathOfNearestExisting(path.resolve(root));
  const candidate = path.resolve(normalizedRoot, relativePath);

  if (!isInside(normalizedRoot, candidate)) {
    throw new SandboxError(`Path is outside the repository root: ${relativePath}`);
  }

  const segments = path.relative(normalizedRoot, candidate).split(path.sep);
  const denied = segments.find((s) => DENIED_SEGMENTS.has(s));
  if (denied) {
    throw new SandboxError(`Access to this path is denied: ${denied}`);
  }

  // Must still be inside the root after following symlinks.
  const real = realpathOfNearestExisting(candidate);
  if (!isInside(normalizedRoot, real)) {
    throw new SandboxError(`Symlink points outside the repository: ${relativePath}`);
  }

  return candidate;
}
