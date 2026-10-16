// Static guard: inline event handlers (onclick=, oninput=, ...) must not interpolate
// raw values into JavaScript. Values must pass through a JS-literal encoder
// (jsArg/jsStr/ja/J/esc(JSON.stringify)) or be numeric. New untrusted interpolation fails CI.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SAFE = /^\s*(Number\(|Math\.(max|min|round|floor)\(|parseInt\(|jsArg\(|jsStr\(|ja\(|J\(|esc\(jsArg\(|esc\(JSON\.stringify\(|attrArgs\(|\d+\s*$)/;
// Reviewed exceptions: numeric locals or values drawn from in-code constants.
const ALLOW = new Set([
  'public/modules/procenter.js|gi', 'public/modules/procenter.js|groupIndex',
  'public/shop-workspace.js|id', 'public/shop-workspace.js|jid',
  "public/shop-workspace.js|boardFilter.stage === k ? '' : k", 'public/shop-workspace.js|k',
  'public/index.html|wo', 'public/index.html|ti', 'public/index.html|k', 'public/index.html|i',
  'public/index.html|idx', 'public/index.html|n', 'public/index.html|offset+limit',
  "public/index.html|type==='customers'?'loadFullbayCustomers':'loadFullbayParts'",
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|js)$/.test(e.name)) out.push(p);
  }
  return out;
}
function interpolations(body) {
  const out = [];
  let i = 0;
  for (;;) {
    const j = body.indexOf('${', i);
    if (j < 0) break;
    let k = j + 2, d = 1;
    while (k < body.length && d) { if (body[k] === '{') d++; else if (body[k] === '}') d--; k++; }
    out.push(body.slice(j + 2, k - 1));
    i = k;
  }
  return out;
}
const bad = [];
for (const f of walk(path.join(ROOT, 'public'))) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bon[a-z]+=(\\?["'])/g)) {
    const q = m[1], start = m.index + m[0].length;
    const end = s.indexOf(q, start);
    if (end < 0) continue;
    const body = s.slice(start, end);
    if (body.includes('\n')) continue; // not an attribute value (a JS source fragment between quotes)
    const queue = interpolations(body);
    while (queue.length) {
      const e = queue.shift();
      if (SAFE.test(e) || ALLOW.has(`${rel}|${e.trim()}`)) continue;
      // A conditional that yields template literals: check the values interpolated inside them.
      if (e.includes('`')) { queue.push(...interpolations(e)); continue; }
      bad.push(`${rel}:${s.slice(0, m.index).split('\n').length}  \${${e}}  in  ${body.slice(0, 160)}`);
    }
  }
}
// Also forbid the historical unsafe pattern explicitly.
for (const f of walk(path.join(ROOT, 'public'))) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/on[a-z]+="[^"\n]*'\$\{encodeURIComponent\(/g)) bad.push(`${rel}:${s.slice(0, m.index).split('\n').length}  encodeURIComponent inside a quoted handler argument`);
}
if (bad.length) {
  console.error(`Inline handler guard: ${bad.length} unsafe interpolation(s):\n` + bad.join('\n'));
  process.exit(1);
}
console.log('Inline handler guard passed: no raw values interpolated into inline event handlers.');
