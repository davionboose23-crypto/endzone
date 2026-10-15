// Captures the CORS-blocked nflverse release feeds (projected rows exactly as prepare.js keeps them)
// so the standalone file can fall back to them when the browser cannot fetch github.com releases.
import fs from 'node:fs';
import { prepareData, cache } from '../server/prepare.js';
const prep = await prepareData({ force: true });
const out = { capturedAt: new Date().toISOString(), season: prep.season, week: prep.week, entries: {} };
for (const [k, v] of cache.map) if (k.startsWith('https://github.com/')) out.entries[k] = { value: v.value, fetchedAt: new Date(v.fetchedAt).toISOString() };
fs.writeFileSync(new URL('./nflverse-bundle.json', import.meta.url), JSON.stringify(out));
console.log(Object.entries(out.entries).map(([k, v]) => `${k.split('/').slice(-2).join('/')} ${Array.isArray(v.value) ? v.value.length : typeof v.value} ${JSON.stringify(v.value).length}`).join('\n'));
