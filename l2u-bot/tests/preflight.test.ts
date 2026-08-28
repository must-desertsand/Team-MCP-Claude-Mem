import { describe, it, expect } from 'vitest';
import {
  meetsVersion,
  evaluateScopes,
  missingModels,
  summarize,
  formatResults,
} from '../src/preflight/evaluate.js';
import type { CheckResult } from '../src/preflight/types.js';

describe('meetsVersion', () => {
  it('accepts an equal version', () => {
    expect(meetsVersion('22.0.0', '22.0.0')).toBe(true);
  });

  it('accepts a higher major', () => {
    expect(meetsVersion('25.9.0', '22.0.0')).toBe(true);
  });

  it('rejects a lower major', () => {
    expect(meetsVersion('20.11.1', '22.0.0')).toBe(false);
  });

  it('compares minor versions when majors match', () => {
    expect(meetsVersion('2.39.5', '2.40.0')).toBe(false);
    expect(meetsVersion('2.41.0', '2.40.0')).toBe(true);
  });

  it('tolerates a leading v and extra suffixes', () => {
    expect(meetsVersion('v22.13.0', '22')).toBe(true);
    expect(meetsVersion('git version 2.39.5 (Apple Git-154)', '2.30')).toBe(true);
  });
});

describe('evaluateScopes', () => {
  it('reports nothing missing when all scopes are granted', () => {
    const v = evaluateScopes([
      'app_mentions:read', 'chat:write', 'channels:history',
      'groups:history', 'users:read', 'reactions:read', 'im:history',
    ]);
    expect(v.missingRequired).toEqual([]);
    expect(v.missingOptional).toEqual([]);
  });

  it('separates required from optional gaps', () => {
    const v = evaluateScopes(['app_mentions:read', 'chat:write', 'channels:history', 'users:read']);
    expect(v.missingRequired).toEqual([]);
    expect(v.missingOptional).toContain('reactions:read');
    expect(v.missingOptional).toContain('im:history');
  });

  it('flags a missing required scope', () => {
    expect(evaluateScopes(['chat:write']).missingRequired).toContain('app_mentions:read');
  });

  it('ignores surrounding whitespace', () => {
    expect(evaluateScopes([' chat:write ', 'app_mentions:read', 'channels:history']).missingRequired).toEqual([]);
  });
});

describe('missingModels', () => {
  it('returns nothing when every configured model exists', () => {
    expect(missingModels(['glm-5.2', 'gemma4'], ['glm-5.2', 'gemma4', 'kimi-k3'])).toEqual([]);
  });

  it('reports models absent from the roster', () => {
    expect(missingModels(['gemini/gemini-2.5-flash'], ['gemini/gemini-3.5-flash'])).toEqual([
      'gemini/gemini-2.5-flash',
    ]);
  });

  it('treats a :cloud suffix as the same model', () => {
    expect(missingModels(['kimi-k2.7-code:cloud'], ['kimi-k2.7-code'])).toEqual([]);
  });
});

describe('summarize', () => {
  const results: CheckResult[] = [
    { name: 'a', status: 'ok', detail: '' },
    { name: 'b', status: 'warn', detail: '' },
    { name: 'c', status: 'fail', detail: '' },
  ];

  it('counts each status', () => {
    const s = summarize(results);
    expect(s).toMatchObject({ ok: 1, warn: 1, fail: 1 });
  });

  it('exits non-zero when anything failed', () => {
    expect(summarize(results).exitCode).toBe(1);
  });

  it('exits zero when only warnings remain', () => {
    expect(summarize(results.slice(0, 2)).exitCode).toBe(0);
  });
});

describe('formatResults', () => {
  it('shows the fix hint for problems only', () => {
    const out = formatResults([
      { name: 'good', status: 'ok', detail: 'fine', fix: 'should not appear' },
      { name: 'bad', status: 'fail', detail: 'broken', fix: 'do this' },
    ]);
    expect(out).not.toContain('should not appear');
    expect(out).toContain('do this');
  });

  it('aligns names into a column', () => {
    const out = formatResults([
      { name: 'a', status: 'ok', detail: 'x' },
      { name: 'longer-name', status: 'ok', detail: 'y' },
    ]);
    const [first, second] = out.split('\n');
    expect(first!.indexOf('x')).toBe(second!.indexOf('y'));
  });
});
