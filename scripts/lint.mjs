// Lightweight lint (no external deps): syntax-checks every source file and flags top-level functions/consts that
// are defined but never referenced anywhere in the codebase. Exit 1 on any problem.
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const roots = ['src', 'public', 'server', 'scripts', 'standalone', 'tests'];
const files = roots.flatMap(function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(m?js)$/.test(e.name) ? [path.join(d, e.name)] : []); });
const src = Object.fromEntries(files.map(f => [f, fs.readFileSync(f, 'utf8')])); const all = Object.values(src).join('\n');
const problems = [];
for (const f of files) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { problems.push(`${f}: syntax: ${String(e.stderr).split('\n').slice(0, 4).join(' ')}`); } }
for (const f of files.filter(f => !f.startsWith('tests/'))) {
  for (const m of src[f].matchAll(/^(?:export )?(?:async )?(?:function\s+(\w+)|const\s+(\w+)\s*=)/gm)) {
    const n = m[1] || m[2]; const uses = (all.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length;
    if (uses <= 1) problems.push(`${f}: '${n}' is defined but never used`);
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); } else console.log(`lint ok: ${files.length} files`);
