/**
 * Slack redelivers an event when the app fails to ack within three seconds.
 * Without deduplication the bot answers the same question twice.
 */
export class EventDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.seen.size;
  }

  isDuplicate(eventId: string): boolean {
    const current = this.now();
    this.evictExpired(current);

    const recordedAt = this.seen.get(eventId);
    if (recordedAt !== undefined && current - recordedAt < this.ttlMs) {
      return true;
    }
    this.seen.set(eventId, current);
    return false;
  }

  private evictExpired(current: number): void {
    for (const [id, at] of this.seen) {
      if (current - at >= this.ttlMs) this.seen.delete(id);
    }
  }
}
