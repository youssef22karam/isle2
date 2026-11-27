// Reassembles the generated whole files from their byte parts.
// The wholes are gitignored; the committed sources are the parts (each under 30 KB).
// Run automatically via the predev/prebuild/prepreview npm hooks, or manually: node tools/reassemble.mjs
//
// Every directory named <file>.parts next to where <file>.<ext> belongs is a target: its parts, in name order,
// are joined into the whole. After editing a whole, run node tools/split.mjs to write its parts again.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
export const MAX_PART_BYTES = 30000;
export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Every <name>.parts directory under src, with the whole it makes and its parts in order.
export function findTargets(dir = join(root, 'src'), out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (!entry.name.endsWith('.parts')) {
      findTargets(path, out);
      continue;
    }
    const parts = readdirSync(path)
      .filter((name) => /\.part\d+\./.test(name))
      .sort();
    if (!parts.length) continue;
    const base = entry.name.slice(0, -'.parts'.length);
    out.push({ whole: join(dir, base + extname(parts[0])), parts: parts.map((name) => join(path, name)) });
  }
  return out;
}
function reassemble() {
  let failed = false;
  for (const target of findTargets()) {
    const chunks = [];
    let ok = true;
    for (const part of target.parts) {
      const size = statSync(part).size;
      if (size > MAX_PART_BYTES) {
        console.error(`reassemble: part exceeds ${MAX_PART_BYTES} bytes (${size}): ${relative(root, part)}`);
        ok = false;
        failed = true;
        continue;
      }
      chunks.push(readFileSync(part));
    }
    if (!ok) continue;
    const whole = Buffer.concat(chunks);
    // Left alone when it already matches, so a watcher is not woken for nothing.
    if (existsSync(target.whole) && readFileSync(target.whole).equals(whole)) continue;
    writeFileSync(target.whole, whole);
    console.log(`reassemble: wrote ${relative(root, target.whole)} (${whole.length} bytes from ${target.parts.length} parts)`);
  }
  if (failed) {
    console.error('reassemble: failed — fix the oversized part(s) above.');
    process.exit(1);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) reassemble();
