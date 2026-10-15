// Run candidate configs walk-forward (budget fit on) over 2024/2025/2026 in parallel. Output data/hist/x-<tag>-<season>.json
import { spawn } from 'node:child_process';
export const CONFIGS = {
  chk: {}, nocaps: { exp: { noCaps: true } },
  combo25: { exp: { glRecK: 12, glSnap: 0.5, teRz: 0.85, lgK: 300, spotK: 0.5 }, weights: { defenseTrust: 0.75, recentBlend: 0.55 } },
  combo26: { exp: { glRecK: 2, glSnap: 0.5, teRz: 1.15, lgK: 300, spotK: 2 }, weights: { defenseTrust: 0.75, recentBlend: 0.55 } },
  def025: { weights: { defenseTrust: 0.25 } }, def0: { weights: { defenseTrust: 0 } },
  glrec2: { exp: { glRecK: 2 } }, glrec3: { exp: { glRecK: 3 } }, glrec12: { exp: { glRecK: 12 } },
  glsnap05: { exp: { glSnap: 0.5 } }, glsnap1: { exp: { glSnap: 1 } }, glsnap2: { exp: { glSnap: 2 } },
  qbr08: { exp: { qbRush: 0.8, qbRushData: 0.8 } }, qbr12: { exp: { qbRush: 1.2, qbRushData: 1.2 } }, qbr15: { exp: { qbRush: 1.5, qbRushData: 1.5 } },
  te085: { exp: { teRz: 0.85 } }, te115: { exp: { teRz: 1.15 } }, te13: { exp: { teRz: 1.3 } },
  lgk25: { exp: { lgK: 25 } }, lgk300: { exp: { lgK: 300 } }, spk05: { exp: { spotK: 0.5 } }, spk2: { exp: { spotK: 2 } },
  def05: { weights: { defenseTrust: 0.5 } }, def075: { weights: { defenseTrust: 0.75 } }, def125: { weights: { defenseTrust: 1.25 } },
  rec025: { weights: { recentBlend: 0.25 } }, rec055: { weights: { recentBlend: 0.55 } }, rec07: { weights: { recentBlend: 0.7 } },
};
if (process.argv[1].endsWith('grid.mjs')) {
  const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const tags = process.argv[2] ? process.argv[2].split(',') : Object.keys(CONFIGS);
  const jobs = tags.flatMap(t => [2024, 2025, 2026].map(s => [t, s]));
  let i = 0; const run = () => { if (i >= jobs.length) return Promise.resolve(); const [t, s] = jobs[i++];
    const cfg = { stack: false, budget: true, opts: extra[t] || CONFIGS[t] };
    return new Promise(r => { const c = spawn('node', ['scripts/hist/walk.mjs', String(s), `x-${t}`, JSON.stringify(cfg)]); let o = ''; c.stdout.on('data', d => o += d); c.stderr.on('data', d => o += d); c.on('close', code => { console.log(t, s, code, o.trim().split('\n').at(-1)); r(); }); }).then(run); };
  await Promise.all(Array.from({ length: 6 }, run));
}
