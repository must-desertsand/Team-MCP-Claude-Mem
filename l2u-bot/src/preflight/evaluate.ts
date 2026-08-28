import type { CheckResult, CheckSummary } from './types.js';

/** Compare dotted version strings. Returns true when actual >= required. */
export function meetsVersion(actual: string, required: string): boolean {
  const parse = (v: string): number[] =>
    (v.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number.parseInt(n, 10));
  const a = parse(actual);
  const r = parse(required);
  for (let i = 0; i < Math.max(a.length, r.length); i += 1) {
    const left = a[i] ?? 0;
    const right = r[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

/** Scopes the bot needs, split by whether their absence breaks a feature outright. */
export const REQUIRED_SCOPES = ['app_mentions:read', 'chat:write', 'channels:history'] as const;
export const OPTIONAL_SCOPES = [
  'groups:history',
  'users:read',
  'reactions:read',
  'im:history',
] as const;

export interface ScopeVerdict {
  readonly missingRequired: string[];
  readonly missingOptional: string[];
}

export function evaluateScopes(granted: readonly string[]): ScopeVerdict {
  const has = new Set(granted.map((s) => s.trim()).filter((s) => s.length > 0));
  return {
    missingRequired: REQUIRED_SCOPES.filter((s) => !has.has(s)),
    missingOptional: OPTIONAL_SCOPES.filter((s) => !has.has(s)),
  };
}

/** Which configured models are absent from the gateway's live roster. */
export function missingModels(
  configured: readonly string[],
  available: readonly string[],
): string[] {
  const roster = new Set(available);
  return configured.filter((m) => !roster.has(m.replace(/:cloud$/, '')) && !roster.has(m));
}

export function summarize(results: readonly CheckResult[]): CheckSummary {
  const count = (s: string): number => results.filter((r) => r.status === s).length;
  const fail = count('fail');
  return { ok: count('ok'), warn: count('warn'), fail, exitCode: fail > 0 ? 1 : 0 };
}

const ICON: Record<string, string> = { ok: '  OK ', warn: ' WARN', fail: ' FAIL' };

export function formatResults(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`[${ICON[r.status]}] ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.fix && r.status !== 'ok') lines.push(`${' '.repeat(width + 10)}→ ${r.fix}`);
  }
  return lines.join('\n');
}
