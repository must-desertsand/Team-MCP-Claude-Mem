import { describe, it, expect } from 'vitest';
import { EventDeduplicator } from '../src/slack/dedupe.js';

describe('EventDeduplicator', () => {
  it('lets a first-seen event through', () => {
    const d = new EventDeduplicator(1000, () => 0);
    expect(d.isDuplicate('Ev1')).toBe(false);
  });

  it('treats a redelivered event_id as a duplicate', () => {
    const d = new EventDeduplicator(1000, () => 0);
    d.isDuplicate('Ev1');
    expect(d.isDuplicate('Ev1')).toBe(true);
  });

  it('keeps distinct event_ids independent', () => {
    const d = new EventDeduplicator(1000, () => 0);
    d.isDuplicate('Ev1');
    expect(d.isDuplicate('Ev2')).toBe(false);
  });

  it('lets an event through again once the TTL passes', () => {
    let now = 0;
    const d = new EventDeduplicator(1000, () => now);
    d.isDuplicate('Ev1');
    now = 1001;
    expect(d.isDuplicate('Ev1')).toBe(false);
  });

  it('evicts expired entries so it does not grow without bound', () => {
    let now = 0;
    const d = new EventDeduplicator(1000, () => now);
    for (let i = 0; i < 100; i += 1) d.isDuplicate(`Ev${i}`);
    now = 5000;
    d.isDuplicate('fresh');
    expect(d.size).toBe(1);
  });
});
