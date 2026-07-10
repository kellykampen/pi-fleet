import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// find every pi-tui/dist/tui.js under both pi installs
const roots = [
  process.env.HOME + '/.pi/agent/npm/node_modules',
  process.env.HOME + '/.local/lib/node_modules/@ai-outfitter/outfitter/node_modules',
];
let files = [];
for (const r of roots) {
  if (!existsSync(r)) continue;
  try {
    const out = execSync(`find "${r}" -path '*/@earendil-works/pi-tui/dist/tui.js'`, {encoding:'utf8'});
    files.push(...out.split('\n').filter(Boolean));
  } catch {}
}
files = [...new Set(files)];

const START = '            if (!isImage && visibleWidth(line) > width) {';
const END = 'throw new Error(errorMsg);\n            }';
let patched = 0, already = 0, missed = 0;
for (const f of files) {
  let src = readFileSync(f, 'utf8');
  if (src.includes('pi-fleet-tui-patch')) { already++; continue; }
  const s = src.indexOf(START);
  const e = src.indexOf(END, s);
  if (s === -1 || e === -1) { missed++; console.log('  ! anchor not found in', f); continue; }
  const block =
    '            if (!isImage && visibleWidth(line) > width) {\n' +
    '                /* pi-fleet-tui-patch: truncate overflowing lines instead of crashing pi\n' +
    '                   (upstream throws on any line wider than the terminal; narrow panes crash) */\n' +
    '                line = sliceByColumn(line, 0, width, true);\n' +
    '            }';
  src = src.slice(0, s) + block + src.slice(e + END.length);
  writeFileSync(f, src);
  patched++; console.log('  ✓ patched', f.replace(process.env.HOME,'~'));
}
console.log(`\npi-tui patch: ${patched} patched, ${already} already, ${missed} missed (of ${files.length} files)`);
