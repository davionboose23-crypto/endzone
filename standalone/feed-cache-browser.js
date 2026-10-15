// Browser build of the feed cache for the standalone file. Same 5-minute freshness and
// last-successful recovery; additionally, when a live load fails (e.g. github.com release
// downloads blocked by CORS) it falls back to the real nflverse rows captured at build time,
// marked stale + bundled with their original capture time. Never invents data.
export const FRESH_MS = 5 * 60 * 1000;
let BUNDLE = { entries: {} };
export function setBundle(b) { BUNDLE = b || { entries: {} }; }
export class FeedCache {
  constructor({ freshMs = FRESH_MS, now = () => Date.now() } = {}) { this.freshMs = freshMs; this.now = now; this.map = new Map(); this.inflight = new Map(); }
  peek(key) { return this.map.get(key) || null; }
  async get(key, loader, { force = false } = {}) {
    const hit = this.map.get(key);
    if (hit && !force && this.now() - hit.fetchedAt < this.freshMs) return { ...hit, cached: true, stale: !!hit.bundled };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await loader();
        const entry = { value, fetchedAt: this.now(), error: null };
        this.map.set(key, entry);
        return { ...entry, cached: false, stale: false };
      } catch (e) {
        if (hit) return { ...hit, cached: true, stale: true, error: String(e.message || e), notFound: !!e.notFound };
        const b = BUNDLE.entries[key];
        if (b) { const entry = { value: b.value, fetchedAt: Date.parse(b.fetchedAt), bundled: true }; this.map.set(key, entry); return { ...entry, cached: true, stale: true, bundled: true, error: `live fetch failed in browser (${String(e.message || e)}); using rows captured ${b.fetchedAt}` }; }
        throw e;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }
  clear() { this.map.clear(); }
}
