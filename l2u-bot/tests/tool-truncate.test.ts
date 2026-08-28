import { describe, it, expect } from 'vitest';
import { truncate } from '../src/agent/truncate.js';

describe('truncate', () => {
  it('leaves content at or under the cap untouched', () => {
    const r = truncate('short', 100);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe('short');
  });

  it('truncates past the cap and states so in the body', () => {
    const r = truncate('x'.repeat(500), 100);
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(100 + 200);
    expect(r.content).toContain('Truncated');
  });

  it('cuts multi-byte characters safely on a byte budget', () => {
    const r = truncate('한'.repeat(200), 100);
    expect(r.truncated).toBe(true);
    expect(() => JSON.parse(JSON.stringify(r.content))).not.toThrow();
    expect(r.content).not.toContain('�');
  });
});
