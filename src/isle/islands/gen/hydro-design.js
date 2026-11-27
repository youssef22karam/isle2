/* =============================================================================
   hydro-design.js — the river network's plan, settled before anything is carved.
   -----------------------------------------------------------------------------
   The tracer in the generator hands back every thread of drainage it finds: on
   the home island some two hundred reaches and nearly fifty separate mouths,
   every one of them then widened into a drowned estuary. Drawn at the 10 m grid's narrowest channel, that is not a river system: it is a coast eaten away by lagoons, and hillsides combed with canals.
   Here the network is generalised the way a cartographer would:
     shapeNetwork      keeps the few river systems that matter, set well apart
                       round the coast, and within each only the tributaries
                       that are long enough and decently spaced; then cuts out
                       any stretch of a reach that doubles back on itself.
     dimensionNetwork  gives each reach its width and depth from the water it
                       carries (downstream hydraulic geometry), opening gently
                       at a confluence, at a lake and at the sea.
   Both copies of the generator (main thread and worker) reach these through
   refineRiverNetwork, so the two always plan the same rivers.
============================================================================= */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth01 = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const hash1 = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
};
// One cell and a little: the narrowest channel a 10 m grid holds without breaking into puddles.
export const HW_MIN = 10.5;
// A river system must be this long and drain this many cells to earn a mouth of its own.
const MIN_RIVER = 460;
const MIN_CATCHMENT = 700;
// Mouths keep this far apart along the coast, in metres.
const MOUTHS_APART = 480;
const ATTRS = ["hw", "depth", "sed", "speed", "q", "curv"];
function arc(p) {
  const n = p.length / 2;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  return s;
}
const endQ = (r) => (r.q && r.q.length ? r.q[r.q.length - 1] : 0);
const mouthOf = (r) => [r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]];
// A reach that comes back to within a few widths of itself after a long way round is cut straight across the neck,
// as a river cuts off a meander. This also removes the hooks and spirals the junction-angle pass can wind up.
function cutLoops(r) {
  let p = r.pts;
  let n = p.length / 2;
  for (let guard = 0; guard < 8 && n > 8; guard++) {
    const s = arc(p);
    let cut = null;
    find: for (let i = 0; i < n - 4; i++) {
      const w = Math.max(r.hw[Math.min(i, r.hw.length - 1)] || HW_MIN, HW_MIN);
      const near = Math.max(48, w * 3.4);
      for (let j = n - 1; j > i + 3; j--) {
        if (s[j] - s[i] < near * 2.6) break;
        if (Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]) < near) {
          cut = [i, j];
          break find;
        }
      }
    }
    if (!cut) break;
    const [i, j] = cut;
    for (const key of ATTRS) if (Array.isArray(r[key]) && r[key].length >= n) r[key] = r[key].slice(0, i + 1).concat(r[key].slice(j));
    p = Array.prototype.slice.call(p, 0, (i + 1) * 2).concat(Array.prototype.slice.call(p, j * 2));
    n = p.length / 2;
  }
  r.pts = p;
  r.length = n > 1 ? arc(p)[n - 1] : 0;
}
export function shapeNetwork(network, ctx) {
  const all = network.reaches;
  if (!all || !all.length || !ctx) return;
  const { N, cell, half, h, cdist } = ctx;
  const at = (x, z) => {
    const i = Math.round((x + half) / cell - 0.5);
    const j = Math.round((z + half) / cell - 0.5);
    return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i;
  };
  const kids = all.map(() => []);
  for (const r of all) if (r.parent >= 0 && r.parent !== r.id && all[r.parent]) kids[r.parent].push(r.id);
  // ---- 1. Which river systems reach the sea ----
  const roots = all.filter((r) => r.parent < 0);
  const main = all.find((r) => r.kind === "main") || roots[0];
  const most = ctx.isHome ? 8 : N >= 480 ? 5 : 4;
  const keep = new Set();
  const mouths = [];
  const take = (r) => {
    keep.add(r.id);
    mouths.push(mouthOf(r));
  };
  if (main) take(main);
  const worth = (r) => endQ(r) * Math.min(1, r.length / 900);
  const ranked = roots.filter((r) => r !== main).sort((a, b) => worth(b) - worth(a));
  for (const r of ranked) {
    if (mouths.length >= most) break;
    if (r.length < MIN_RIVER || endQ(r) < MIN_CATCHMENT) continue;
    const [mx, mz] = mouthOf(r);
    if (mouths.some(([x, z]) => Math.hypot(x - mx, z - mz) < MOUTHS_APART)) continue;
    take(r);
  }
  // ---- 2. The tributaries worth drawing ----
  // Longest and best fed first; each must be long enough for its rank, must not crowd a neighbour that joins the
  // same bank, and a reach carries only as many as its length has room for.
  const highest = (r) => {
    let top = -1e9;
    for (let i = 0; i < r.pts.length / 2; i += 2) {
      const k = at(r.pts[i * 2], r.pts[i * 2 + 1]);
      if (k >= 0 && h[k] > top) top = h[k];
    }
    return top;
  };
  const visit = (id, level) => {
    const r = all[id];
    const n = r.pts.length / 2;
    if (n < 3) return;
    const s = arc(r.pts);
    const found = [];
    for (const cid of kids[id]) {
      const c = all[cid];
      const m = c.pts.length / 2;
      if (m < 3) continue;
      const [ex, ez] = mouthOf(c);
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = (r.pts[i * 2] - ex) ** 2 + (r.pts[i * 2 + 1] - ez) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      const i0 = Math.max(0, best - 1);
      const i1 = Math.min(n - 1, best + 1);
      const tx = r.pts[i1 * 2] - r.pts[i0 * 2];
      const tz = r.pts[i1 * 2 + 1] - r.pts[i0 * 2 + 1];
      const back = Math.max(0, m - 6);
      const side = Math.sign(tx * (c.pts[back * 2 + 1] - ez) - tz * (c.pts[back * 2] - ex)) || 1;
      found.push({ c, at: s[best], side, score: c.length * (0.5 + Math.min(1.5, endQ(c) / 700)) });
    }
    found.sort((a, b) => b.score - a.score);
    const kept = [];
    const room = Math.max(1, Math.round(r.length / 125));
    for (const f of found) {
      const c = f.c;
      // The delta's second channel stays with the main river.
      if (c.origKind === "distributary") {
        if (level === 0 && r === main) keep.add(c.id);
        continue;
      }
      if (level >= 4 || kept.length >= room) continue;
      if (c.length < (level === 0 ? 150 : 175)) continue;
      // A wandering tidal creek follows no valley: only where the ground is truly low, and never near the top of a reach.
      if (!c.cells || !c.cells.length) {
        if (level > 0 || highest(c) > 11 || f.at < r.length * 0.3) continue;
        const k = at(c.pts[0], c.pts[1]);
        if (k < 0 || cdist[k] < 140) continue;
      }
      if (kept.some((o) => Math.abs(o.at - f.at) < (o.side === f.side ? 150 : 60))) continue;
      kept.push(f);
      keep.add(c.id);
      visit(c.id, level + 1);
    }
  };
  for (const r of roots) if (keep.has(r.id)) visit(r.id, 0);
  // ---- 3. The reaches kept, renumbered ----
  const order = all.filter((r) => keep.has(r.id));
  const renumber = new Map(order.map((r, i) => [r.id, i]));
  for (const r of order) {
    r.parent = r.parent >= 0 ? (renumber.get(r.parent) ?? -1) : -1;
    r.id = renumber.get(r.id);
  }
  network.reaches = order;
  // ---- 4. Cut-off meanders only beside a river that is still there, well inland, and a few at most ----
  if (network.oxbows) {
    const beside = (ox) =>
      order.some((r) => {
        for (let i = 0; i < r.pts.length / 2; i += 2) if (Math.hypot(r.pts[i * 2] - ox.x, r.pts[i * 2 + 1] - ox.z) < 110) return true;
        return false;
      });
    network.oxbows = network.oxbows
      .filter((ox) => {
        const k = at(ox.x, ox.z);
        return k >= 0 && cdist[k] > 300 && h[k] < 26 && beside(ox);
      })
      .slice(0, 5);
  }
  // ---- 5. No reach doubles back on itself ----
  for (const r of order) cutLoops(r);
  if (network.stats)
    network.stats.design = {
      found: all.length,
      kept: order.length,
      mouths: mouths.length,
      ofMouths: roots.length,
      oxbows: network.oxbows ? network.oxbows.length : 0,
    };
}
// Width and depth from discharge. q is the catchment in cells (100 m2 each): a main river draining a couple of
// square kilometres comes out some 50 m wide at its mouth, a headwater stream at the grid's 21 m.
export function dimensionNetwork(network, ctx = {}) {
  const reaches = network.reaches;
  if (!reaches || !reaches.length) return;
  const basins = ctx.basins || [];
  // The way a boat goes: the main river, and from each lake down to the sea.
  const nav = new Set();
  const climb = (r) => {
    for (let guard = 0; r && guard < 64; guard++) {
      nav.add(r.id);
      r = r.parent >= 0 && r.parent !== r.id ? reaches[r.parent] : null;
    }
  };
  for (const r of reaches) {
    if (r.parent < 0 || r.kind === "main" || r.kind === "secondary") climb(r);
  }
  for (const b of basins) if (b.reach) climb(b.reach);
  for (const r of reaches) {
    const n = Math.min(r.hw.length, r.pts.length / 2);
    if (n < 2) continue;
    const s = arc(r.pts);
    const L = s[n - 1];
    const root = r.parent < 0;
    const top = r.kind === "main" ? 27 : r.kind === "secondary" ? 21.5 : r.kind === "tributary" ? 15.5 : 12;
    const deep = r.kind === "main" ? 5.2 : r.kind === "secondary" ? 4.3 : r.kind === "tributary" ? 3.2 : 2.4;
    const hw = new Array(n);
    const depth = new Array(n);
    let carried = 1;
    for (let i = 0; i < n; i++) {
      // A river does not lose water on its way down.
      carried = Math.max(carried, r.q[i] || 1);
      hw[i] = clamp(0.9 * Math.pow(carried, 0.32), HW_MIN, top);
      depth[i] = clamp(0.5 * Math.pow(carried, 0.24), 1.7, deep);
    }
    for (let pass = 0; pass < 4; pass++)
      for (let i = 1; i < n - 1; i++) {
        hw[i] = (hw[i - 1] + 2 * hw[i] + hw[i + 1]) / 4;
        depth[i] = (depth[i - 1] + 2 * depth[i] + depth[i + 1]) / 4;
      }
    const phase = hash1(r.pts[0] * 0.013 + r.pts[1] * 0.007) * Math.PI * 2;
    const boat = nav.has(r.id);
    for (let i = 0; i < n; i++) {
      const down = L - s[i];
      let w = hw[i];
      // Pools and narrows, a dozen widths apart.
      w *= 1 + 0.09 * Math.sin((s[i] / Math.max(w * 15, 90)) * Math.PI * 2 + phase);
      // It opens a little where it meets the sea, and less where it meets its parent.
      w *= root ? 1 + 0.4 * (1 - smooth01(0, 180, down)) : 1 + 0.18 * (1 - smooth01(0, 50, down));
      // And where it runs into or out of a lake.
      for (const b of basins) {
        const d = Math.hypot(r.pts[i * 2] - b.x, r.pts[i * 2 + 1] - b.z) / Math.max(b.r, 1);
        if (d < 1.9) w *= 1 + 0.3 * (1 - smooth01(0.9, 1.9, d));
      }
      let d = depth[i];
      if (boat) {
        const tDown = s[i] / Math.max(L, 1);
        w = Math.max(w, 14.5 + 5.5 * tDown);
        d = Math.max(d, 3.1 + 0.9 * tDown);
      }
      r.hw[i] = Math.max(HW_MIN, w);
      r.depth[i] = d;
    }
    r.navigable = boat;
  }
}
