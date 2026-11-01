import fs from 'node:fs'; const A = ['11','23','37'].map(s => JSON.parse(fs.readFileSync(`b1k_${s}.json`,'utf8')).B26.players);
const out = JSON.parse(fs.readFileSync('b1k_11.json','utf8')); const key = r => r.gid + '|' + r.id; const M = A.slice(1).map(P => new Map(P.map(r => [key(r), r])));
out.B26.players = A[0].map(r => { const o = { ...r }; for (const k of ['pbp2New','driveNew']) if (r[k] != null) o[k] = (r[k] + M.reduce((s, m) => s + (m.get(key(r))?.[k] ?? r[k]), 0)) / 3; return o; });
fs.writeFileSync('avg3k.json', JSON.stringify(out));
