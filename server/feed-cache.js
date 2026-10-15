// Shared server feed cache: 5-minute freshness, in-flight de-duplication, and
// last-successful recovery. A TTL never triggers a refresh by itself.
export const FRESH_MS = 5 * 60 * 1000;
export class FeedCache {
  constructor({ freshMs = FRESH_MS, now = () => Date.now() } = {}) { this.freshMs = freshMs; this.now = now; this.map = new Map(); this.inflight = new Map(); }
  peek(key) { return this.map.get(key) || null; }
  async get(key, loader, { force = false } = {}) {
    const hit = this.map.get(key);
    if (hit && !force && this.now() - hit.fetchedAt < this.freshMs) return { ...hit, cached: true, stale: false };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await loader();
        const entry = { value, fetchedAt: this.now(), error: null };
        this.map.set(key, entry);
        return { ...entry, cached: false, stale: false };
      } catch (e) {
        if (hit) return { ...hit, cached: true, stale: true, error: String(e.message || e), notFound: !!e.notFound };
        throw e;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }
  clear() { this.map.clear(); }
}
