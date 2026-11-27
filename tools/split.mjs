// The other half of reassemble.mjs: writes every source file over 30 KB back out as byte parts, cut at line
// ends, into <file>.parts/<file>.partNN.<ext>. Whole files remain versioned for standard Vite builds.
// Run after editing a whole file: node tools/split.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { MAX_PART_BYTES, findTargets, root } from './reassemble.mjs';
const KINDS = new Set(['.js', '.ts', '.tsx', '.css', '.mjs']);
// A little under the limit, so a part stays legal after a small hand edit.
const AIM = MAX_PART_BYTES - 1500;
function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.endsWith('.parts')) sources(path, out);
    } else if (KINDS.has(extname(entry.name)) && !/\.part\d+\./.test(entry.name)) out.push(path);
  }
  return out;
}
const wholes = [];
for (const file of sources(join(root, 'src'))) {
  const dir = join(dirname(file), basename(file, extname(file)) + '.parts');
  if (statSync(file).size <= MAX_PART_BYTES) {
    // Small enough to be committed as it is: any parts left from when it was larger are out of date.
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    continue;
  }
  const lines = readFileSync(file, 'utf8').split(/(?<=\n)/);
  const parts = [];
  let current = '';
  for (const line of lines) {
    if (current && Buffer.byteLength(current) + Buffer.byteLength(line) > AIM) {
      parts.push(current);
      current = '';
    }
    current += line;
  }
  if (current) parts.push(current);
  const tooLong = parts.find((p) => Buffer.byteLength(p) > MAX_PART_BYTES);
  if (tooLong) {
    console.error(`split: a single line of ${relative(root, file)} is longer than ${MAX_PART_BYTES} bytes; break it up.`);
    process.exit(1);
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  parts.forEach((text, i) => {
    const name = `${basename(file, extname(file))}.part${String(i + 1).padStart(2, '0')}${extname(file)}`;
    writeFileSync(join(dir, name), text);
  });
  wholes.push(relative(root, file).split('\\').join('/'));
  console.log(`split: ${relative(root, file)} -> ${parts.length} parts`);
}
// Proof that joining the parts gives back each whole, byte for byte.
for (const target of findTargets()) {
  const joined = Buffer.concat(target.parts.map((p) => readFileSync(p)));
  if (!joined.equals(readFileSync(target.whole))) {
    console.error(`split: parts do not rebuild ${relative(root, target.whole)}`);
    process.exit(1);
  }
}
writeFileSync(join(root, '.gitignore'), ['node_modules', 'dist', '.debug', 'artifacts', '.DS_Store', ''].join('\n'));
console.log(`split: ${wholes.length} whole files synchronized with their parts`);
