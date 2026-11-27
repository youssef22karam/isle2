/* =============================================================================
   wetlands.js — still water put where still water belongs.
   -----------------------------------------------------------------------------
   Run once the rivers and lakes are carved, before the waterlines are sculpted.
   1. Stray water. The generator used to turn any ground left below the datum
      into a "swamp pool", and those pools gathered along the coast as dark
      lagoons opening straight into the sea. Pools no river made are filled
      back to damp ground; only a small cut-off meander well inland is kept.
      No dry cell is left below the datum, where the sea would have shown
      through as a turquoise puddle.
   2. Swamps. A swamp is a place, not a tint along every lowland bank. One to
      three basins are chosen beside a river's lower course, on the lowest,
      flattest ground well back from the sea, and built as a real backswamp:
        - a mosaic of shallow blackwater (0.4 to 0.8 m),
        - hummocks standing a hand above it for the trees to root on,
        - winding sloughs (to 2 m) kept open, as navMask, for a boat,
        - a deep lagoon (to 3 m) in the middle,
        - a bayou cut through to the river, so it is fed and can be entered,
        - the ground round it graded down, so it lies in a hollow, not a pit.
      The scatter plants mangrove, tree fern, horsetail, reed and lily from
      the swamp field and the depth, so the forest follows the mosaic.
   3. Fields. swamp, inl (1 on fresh water, a short plume on the sea off a
      river mouth), fresh (how near fresh water the ground lies), the sea's
      sediment plume, and the list of marshes are rebuilt from the result.
============================================================================= */
const LAND = 0;
const SEA = 1;
const SWAMP = 5;
// A boat's draught and a little: deeper swamp water than this is kept clear of trees.
const NAV_DEPTH = 1.55;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth01 = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
// Value noise and fbm from the place alone, so both copies of the generator draw the same swamp.
function noiseFor(seed) {
  const cellHash = (ix, iz) => {
    let n = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + seed) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  };
  const value = (x, z) => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const u = fx * fx * (3 - 2 * fx);
    const v = fz * fz * (3 - 2 * fz);
    const a = cellHash(ix, iz);
    const b = cellHash(ix + 1, iz);
    const c = cellHash(ix, iz + 1);
    const d = cellHash(ix + 1, iz + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  // In about [-1, 1].
  const fbm = (x, z, octaves = 3) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let total = 0;
    for (let i = 0; i < octaves; i++) {
      sum += (value(x * freq + i * 17.3, z * freq - i * 9.1) * 2 - 1) * amp;
      total += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / total;
  };
  return { value, fbm };
}
// Each cell's distance in metres to the nearest marked cell, by a two-pass chamfer.
function distanceTo(N, cell, marked) {
  const d = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) d[k] = marked[k] ? 0 : 1e9;
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let z = 0; z < N; z++)
    for (let x = 0; x < N; x++) {
      const k = z * N + x;
      let v = d[k];
      if (x > 0) v = Math.min(v, d[k - 1] + a);
      if (z > 0) {
        v = Math.min(v, d[k - N] + a);
        if (x > 0) v = Math.min(v, d[k - N - 1] + b);
        if (x < N - 1) v = Math.min(v, d[k - N + 1] + b);
      }
      d[k] = v;
    }
  for (let z = N - 1; z >= 0; z--)
    for (let x = N - 1; x >= 0; x--) {
      const k = z * N + x;
      let v = d[k];
      if (x < N - 1) v = Math.min(v, d[k + 1] + a);
      if (z < N - 1) {
        v = Math.min(v, d[k + N] + a);
        if (x < N - 1) v = Math.min(v, d[k + N + 1] + b);
        if (x > 0) v = Math.min(v, d[k + N - 1] + b);
      }
      d[k] = v;
    }
  return d;
}
function distToPath(x, z, path) {
  let best = 1e18;
  for (let i = 0; i < path.length; i += 2) {
    const d = (path[i] - x) ** 2 + (path[i + 1] - z) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
// A wandering line from one point to another, sampled every few metres.
function wander(sx, sz, ex, ez, bow, ripple) {
  const dx = ex - sx;
  const dz = ez - sz;
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  const steps = Math.max(6, Math.round(len / 5));
  const path = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const off = Math.sin(t * Math.PI) * len * bow + Math.sin(t * Math.PI * 3) * len * ripple;
    path.push(sx + dx * t + nx * off, sz + dz * t + nz * off);
  }
  return path;
}
export function finishHydrology(o) {
  const { N, cell, half, h, wet, body, inl, lakeId, flowX, flowZ, sed, swamp, navMask, rivers, lakes, marshes, fresh, cdist } = o;
  if (!h || !wet || !body || !swamp || !fresh || !cdist) return null;
  const NN = N * N;
  const nz = noiseFor(((o.seed | 0) ^ 0x5bd1e995) | 0);
  const ocean = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) ocean[k] = body[k] === SEA ? 1 : 0;
  const xOf = (k) => ((k % N) + 0.5) * cell - half;
  const zOf = (k) => (((k / N) | 0) + 0.5) * cell - half;
  const at = (x, z) => {
    const i = Math.round((x + half) / cell - 0.5);
    const j = Math.round((z + half) / cell - 0.5);
    return i < 1 || j < 1 || i >= N - 1 || j >= N - 1 ? -1 : j * N + i;
  };
  const report = { filled: 0, ponds: 0, raised: 0, basins: [] };
  // ---------------------------------------------------------------- 1. stray water
  const pond = new Uint8Array(NN);
  {
    const seen = new Uint8Array(NN);
    const stack = [];
    for (let start = 0; start < NN; start++) {
      if (seen[start] || !wet[start] || ocean[start] || body[start] !== SWAMP || lakeId[start] >= 0) continue;
      const cells = [];
      let touchesSea = false;
      let coast = Infinity;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const k = stack.pop();
        cells.push(k);
        if (cdist[k] < coast) coast = cdist[k];
        const x = k % N;
        const z = (k / N) | 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const qx = x + dx;
            const qz = z + dz;
            if (qx < 0 || qz < 0 || qx >= N || qz >= N) continue;
            const q = qz * N + qx;
            if (ocean[q]) touchesSea = true;
            else if (!seen[q] && wet[q] && body[q] === SWAMP && lakeId[q] < 0) {
              seen[q] = 1;
              stack.push(q);
            }
          }
      }
      // A cut-off meander: small, well inland, nowhere near the sea.
      if (!touchesSea && coast > 260 && cells.length >= 3 && cells.length <= 70) {
        for (const k of cells) pond[k] = 1;
        report.ponds++;
        continue;
      }
      for (const k of cells) {
        h[k] = 0.18 + 0.3 * nz.value(xOf(k) / 37, zOf(k) / 37);
        wet[k] = 0;
        body[k] = LAND;
        flowX[k] = 0;
        flowZ[k] = 0;
        sed[k] = 0;
        if (navMask) navMask[k] = 0;
        report.filled++;
      }
    }
    for (let k = 0; k < NN; k++)
      if (!ocean[k] && !wet[k] && h[k] < 0.12) {
        h[k] = 0.14 + 0.22 * nz.value(xOf(k) / 37, zOf(k) / 37);
        body[k] = LAND;
        report.raised++;
      }
  }
  // ---------------------------------------------------------------- 2. swamp basins
  const basins = [];
  const shape = (B, x, z) => {
    const dx = x - B.x;
    const dz = z - B.z;
    const a = dx * B.ux + dz * B.uz;
    const b = -dx * B.uz + dz * B.ux;
    const wobble = nz.fbm(x / 95 + 3.1, z / 95 - 1.7, 3) * 0.27 + nz.fbm(x / 34 + 9, z / 34, 2) * 0.08;
    return { a, b, rho: Math.hypot(a / (B.R * 1.4), b / (B.R * 0.74)) + wobble };
  };
  const want = o.isHome ? 3 : N >= 480 ? 2 : 1;
  const sizes = [240, 200, 165];
  const scaleR = clamp(N / 640, 0.72, 1.05);
  for (let b = 0; b < want && rivers && rivers.length; b++) {
    const R = sizes[b] * scaleR;
    let best = null;
    // Strictly the low flat ground first; then, on an island with none, the best that can be had.
    for (let attempt = 0; attempt < 2 && !best; attempt++) {
      const meanMost = attempt ? 24 : 12; const topMost = attempt ? 66 : 36; const margin = 150;
      for (let ri = 0; ri < rivers.length; ri++) {
        const r = rivers[ri];
        const n = Math.min(r.hw.length, r.pts.length / 2);
        if (n < 12 || (r.kind === "tributary" && r.length < 520)) continue;
        for (let i = 4; i < n - 4; i += 2) {
          const x = r.pts[i * 2];
          const z = r.pts[i * 2 + 1];
          const tx = r.pts[i * 2 + 2] - r.pts[i * 2 - 2];
          const tz = r.pts[i * 2 + 3] - r.pts[i * 2 - 1];
          const tl = Math.hypot(tx, tz) || 1;
          const ux = tx / tl;
          const uz = tz / tl;
          for (const side of [-1, 1]) {
            const off = R * 0.5 + r.hw[i];
            const cx = x - uz * side * off;
            const cz = z + ux * side * off;
            const kc = at(cx, cz);
            if (kc < 0 || cdist[kc] < R * 0.75 + margin) continue;
            if ((lakes || []).some((l) => Math.hypot(l.x - cx, l.z - cz) < l.r * 2.4 + R)) continue;
            if (basins.some((p) => Math.hypot(p.x - cx, p.z - cz) < (p.R + R) * 1.8 + 260)) continue;
            // The ground it would drown.
            let sum = 0;
            let count = 0;
            let top = 0;
            let ok = true;
            for (let ring = 1; ring <= 3 && ok; ring++)
              for (let s = 0; s < 10; s++) {
                const ang = s * 0.6283 + ring * 0.31;
                const pa = Math.cos(ang) * R * 1.4 * ring * 0.31; const pb = Math.sin(ang) * R * 0.74 * ring * 0.31;
                const k = at(cx + ux * pa - uz * pb, cz + uz * pa + ux * pb);
                if (k < 0 || ocean[k] || lakeId[k] >= 0) {
                  ok = false;
                  break;
                }
                if (wet[k]) continue;
                sum += h[k];
                count++;
                if (h[k] > top) top = h[k];
              }
            if (!ok || count < 12) continue;
            const mean = sum / count;
            if (mean > meanMost || top > topMost) continue;
            const rank = r.kind === "main" ? 5 : r.kind === "secondary" ? 3 : 0;
            const score = -mean * 1.4 - top * 0.25 + rank + Math.min(cdist[kc], 520) * 0.008 + nz.value(cx / 53, cz / 53) * 2;
            if (!best || score > best.score) best = { score, x: cx, z: cz, R, ux, uz, rx: x, rz: z, river: r, mean, top, turn: side };
          }
        }
      }
    }
    if (!best) break;
    basins.push(best);
  }
  for (const B of basins) {
    // The lagoon lies a little downstream of the middle; a bayou runs from it to the river, a slough up the basin.
    const lx = B.x + B.ux * B.R * 0.1;
    const lz = B.z + B.uz * B.R * 0.1;
    const bayou = wander(lx, lz, B.rx, B.rz, 0.16 * B.turn, 0.045);
    const slough2 = wander(lx, lz, B.x - B.ux * B.R * 1.02, B.z - B.uz * B.R * 1.02, -0.2 * B.turn, 0.06);
    const reach = B.R * 2.5;
    const x0 = Math.max(1, Math.floor((B.x - reach + half) / cell));
    const x1 = Math.min(N - 2, Math.ceil((B.x + reach + half) / cell));
    const z0 = Math.max(1, Math.floor((B.z - reach + half) / cell));
    const z1 = Math.min(N - 2, Math.ceil((B.z + reach + half) / cell));
    B.box = [x0, x1, z0, z1];
    for (let iz = z0; iz <= z1; iz++)
      for (let ix = x0; ix <= x1; ix++) {
        const k = iz * N + ix;
        if (ocean[k] || lakeId[k] >= 0) continue;
        const x = (ix + 0.5) * cell - half;
        const z = (iz + 0.5) * cell - half;
        const { a, b, rho } = shape(B, x, z);
        if (rho > 1.75) continue;
        // Never down to the shore: a swamp open to the sea is a lagoon.
        const core = (1 - smooth01(0.78, 1.0, rho)) * smooth01(110, 190, cdist[k]);
        // Water: broad shallows, with sloughs, the bayou and the lagoon let into them.
        const broad = nz.fbm(x / 70 - 8, z / 70 + 2, 2) * 0.5 + 0.5;
        let depth = 0.4 + 0.42 * broad;
        const vein = nz.fbm(x / 120 + 5.5 + 0.35 * nz.fbm(x / 60, z / 60, 2), z / 120 - 3.3, 2);
        const slough = 1 - smooth01(0.03, 0.105, Math.abs(vein));
        depth = Math.max(depth, 0.5 + 1.45 * slough);
        const la = (a - B.R * 0.1) / (B.R * 0.27);
        const lb = b / (B.R * 0.18);
        const lagoon = Math.exp(-0.5 * (la * la + lb * lb));
        depth = Math.max(depth, 3 * smooth01(0.3, 0.72, lagoon));
        const cut = Math.max(1 - smooth01(7, 16, distToPath(x, z, bayou)), 0.85 * (1 - smooth01(6, 14, distToPath(x, z, slough2))));
        depth = Math.max(depth, 2.15 * cut);
        const open = Math.max(slough, cut, smooth01(0.25, 0.6, lagoon));
        // Hummocks: tree islands a few cells across, never in the open channels.
        const island = smooth01(0.45, 0.59, nz.fbm(x / 24 + 40, z / 24 - 12, 2) * 0.5 + 0.5 + 0.1 * (broad - 0.5)) * (1 - open);
        const target = mix(-depth, 0.24 + 0.5 * nz.value(x / 13, z / 13), island);
        let next = mix(h[k], target, core);
        // The ground round it comes down to it in a gentle hollow.
        const out = Math.max(0, rho - 0.92) * B.R;
        const cap = 0.45 + out * 0.14 + out * out * 0.0005; if (next > cap) next = mix(cap, next, smooth01(1.08, 1.75, rho));
        if (wet[k]) {
          // A river or a pond already here keeps its bed.
          if (next < h[k]) h[k] = next;
          continue;
        }
        if (core < 0.004 && next >= h[k]) continue;
        // Nothing left lying exactly at the waterline.
        if (next < 0.1 && next > -0.12) next = next < 0 ? -0.14 : 0.12;
        h[k] = next;
        if (next < 0) {
          wet[k] = 1;
          body[k] = SWAMP;
          sed[k] = 0.74;
          flowX[k] = 0;
          flowZ[k] = 0;
          if (navMask) navMask[k] = -next >= NAV_DEPTH ? 1 : 0;
        }
      }
  }
  // ---------------------------------------------------------------- 3. fields
  swamp.fill(0);
  for (const B of basins) {
    const [x0, x1, z0, z1] = B.box;
    let area = 0;
    let deepest = 0;
    let volume = 0;
    for (let iz = z0; iz <= z1; iz++)
      for (let ix = x0; ix <= x1; ix++) {
        const k = iz * N + ix;
        const { rho } = shape(B, (ix + 0.5) * cell - half, (iz + 0.5) * cell - half);
        const s = 1 - smooth01(0.9, 1.34, rho);
        if (s > swamp[k]) swamp[k] = s;
        if (s > 0.5 && wet[k] && body[k] === SWAMP) {
          area += cell * cell;
          volume += -h[k] * cell * cell;
          if (-h[k] > deepest) deepest = -h[k];
        }
      }
    B.area = area;
    B.deepest = deepest;
    B.meanDepth = area ? volume / area : 0;
  }
  // A cut-off meander is a little swamp of its own.
  for (let k = 0; k < NN; k++) {
    if (!pond[k]) continue;
    const x = k % N;
    const z = (k / N) | 0;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const qx = x + dx;
        const qz = z + dz;
        if (qx < 0 || qz < 0 || qx >= N || qz >= N) continue;
        const v = 0.74 * (1 - Math.hypot(dx, dz) / 3.2);
        const q = qz * N + qx;
        if (v > swamp[q]) swamp[q] = v;
      }
  }
  // inl: 1 on fresh water; on the sea a short plume off each mouth, where the two surfaces cross-fade.
  // fresh: how near fresh water the ground lies (green banks, and the ocean shader's bank test).
  const freshWater = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) freshWater[k] = wet[k] && !ocean[k] ? 1 : 0;
  const far = distanceTo(N, cell, freshWater);
  for (let k = 0; k < NN; k++) {
    if (ocean[k]) {
      inl[k] = clamp(0.95 * Math.exp(-far[k] / 46), 0, 0.98);
      fresh[k] = 0;
      sed[k] = clamp(0.6 * Math.exp(-far[k] / 130));
    } else if (wet[k]) {
      inl[k] = 1;
      fresh[k] = 1;
    } else {
      inl[k] = 0;
      fresh[k] = Math.max(Math.exp(-far[k] / 80), swamp[k] * 0.85);
    }
  }
  // The marshes, for the map and the Swamp destination.
  if (marshes) {
    const names = marshes.map((m) => m.name);
    marshes.length = 0;
    basins.forEach((B, i) => {
      if (B.area < 6000) return;
      let name = names[i] || `${String(B.river?.name || "Still").split(" ")[0]} Marsh`;
      while (marshes.some((m) => m.name === name)) name = `Upper ${name}`;
      marshes.push({
        name,
        x: B.x,
        z: B.z,
        r: B.R * 1.05,
        level: 0,
        area: B.area,
        maxDepth: Math.min(B.deepest, 3.4),
        meanDepth: Math.min(B.meanDepth, 1.6),
        outlet: B.river?.name ?? "Sea",
      });
      report.basins.push({ name, x: Math.round(B.x), z: Math.round(B.z), r: Math.round(B.R), ha: +(B.area / 1e4).toFixed(1), ground: +B.mean.toFixed(1), top: +B.top.toFixed(0), coast: Math.round(cdist[at(B.x, B.z)]), deepest: +B.deepest.toFixed(1) });
    });
    marshes.report = report;
  }
  return report;
}
