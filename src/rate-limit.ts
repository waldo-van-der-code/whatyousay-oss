// In-process sliding-window limiter. Fine here: the app is a single pm2 fork
// process (see README, Architecture), so there is nothing to share.

const MAX_KEYS = 50_000;

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Records a hit for `key` and reports whether it is within the limit. Blocked hits are not recorded. */
  hit(key: string, now = Date.now()): { ok: boolean; retryAfterS: number } {
    this.sweep(now);
    // Forged per-IP keys could otherwise pile up inside one window. Forgetting
    // everyone briefly is cheaper than unbounded memory.
    if (this.hits.size >= MAX_KEYS && !this.hits.has(key)) this.hits.clear();
    const list = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000)) };
    }
    list.push(now);
    this.hits.set(key, list);
    return { ok: true, retryAfterS: 0 };
  }

  reset(): void {
    this.hits.clear();
  }

  // Drop idle keys once per window so the map cannot grow without bound.
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, list] of this.hits) {
      if (!list.length || now - list[list.length - 1] >= this.windowMs) this.hits.delete(key);
    }
  }
}
