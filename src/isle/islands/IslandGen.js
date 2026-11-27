// IslandGen.js — island29 island generation for the tidewater-islands hybrid.
//
// Source of truth (island29, ~/workspace/island29-update/raw/src/):
//   - engine/island/part13.js: ra / Or / Mn (archipelago cell hash, occupancy,
//     descriptor) — ported below (cellHash / cellHasIsland / islandDescriptor).
//   - THE GENERATOR ITSELF IS NOT RE-IMPLEMENTED ANY MORE. generateIslandGrid
//     drives island29's own terrain-worker generator `kn`
//     (engine/terrain/part05.js) from a verbatim copy of the original modules
//     under ./gen/ (terrain parts 01-05 + hydrology.js + hydro-design.js +
//     wetlands.js + water-coverage.js + geology.js, byte-identical to
//     island29's source — see REPORT.md). Every stage runs, in kn's own order:
//     archetype fill → fn (hydrology design) → un (droplet erosion) → meadow
//     smoothing → He (thermal erosion) → sea-connectivity fixup → coast
//     distance + mn (beach shaping) → Ve (river/lake/marsh network evolution,
//     incl. refineRiverNetwork + finishHydrology) → He again (wet-protected)
//     → carveNavigablePassages (which runs sculptBreathtakingGeology with the
//     real rivers/lakes/marshes) → sculptRiverWaterlines → coast distance
//     recomputed → pn (flow/tau) → ambient occlusion. The result is kn's own
//     world object: heights plus wet / swamp / fresh / level / lakeId / body /
//     sed / bankDist / navMask / flow fields and the rivers / lakes / marshes
//     records — the full geo terrain, rivers, lakes and wetlands included.
//
// History: the first version of this module was a de-minified re-implementation
// of kn's stages 1-4 only (fill, meadow smoothing, connectivity, mn), with the
// hydrology stages skipped by the then-current recipe and geology run
// separately on empty lists. It diverged from island29's real output by
// ~9.3 m mean in the beach band and ~29 m in the interior (measured against
// the real kn, seed-504 home island) and produced no rivers, lakes or
// wetlands at all. Nino revoked the exclusion on 2026-11-27; the generator
// is now the original code, driven with exactly the inputs island29's own
// worker receives: { seed, N, cell, isHome } (terrain/part09.js postMessage
// payload — note there is NO erosionDroplets key; un() uses its default).
//
// kn is a generator (it yields {label, p} progress); generateIslandGrid
// drains it synchronously, generateIslandGridAsync pumps it with frame
// yields so the page can paint progress.

// ---------------------------------------------------------------------------
// Archipelago layout (part13.js: ro, Gr, ra, Or, Mn — constants & hash exact)
// ---------------------------------------------------------------------------

// island29's own world seed: its App.tsx boots with seed 504 (state.seed and
// the regenerate call both default to 504, overridable via ?seed= in the URL).
// The app passes that seed as worldSeed into Or/Mn (part14), so the whole
// archipelago — home island included — is a function of it. (This port
// previously used 1337, which generated a DIFFERENT archipelago than the
// island29 app the user knows; aligned to 504 on 2026-11-27.)
export const WORLD_SEED = 504;

export const ARCHIPELAGO = {
  cellSize: 8000, // ro
  gridCell: 10, // Gr (metres per heightfield texel)
  worldSeed: WORLD_SEED,
};

const CELL_SIZE = 8000; // ro
const GRID_CELL = 10; // Gr

// ra(o, e, t, r): cell hash -> [0, 1). Args here: (cx, cz, salt, seed).
export function cellHash(cx, cz, salt, seed) {
  let s =
    (Math.imul(cx | 0, 374761393) +
      Math.imul(cz | 0, 668265263) +
      Math.imul(salt | 0, 2246822519) +
      Math.imul(seed | 0, 1597334677)) |
    0;
  return (
    (s = Math.imul(s ^ (s >>> 13), 1274126177)),
    (s ^= s >>> 16),
    (s >>> 0) / 4294967296
  );
}

// Or(o, e, t): the home cell (0,0) always has an island; others hash < 0.72.
export function cellHasIsland(cx, cz, seed) {
  return (cx === 0 && cz === 0) || cellHash(cx, cz, 1, seed) < 0.72;
}

// Mn(o, e, t): island descriptor. cx/cz in the result are the island centre in
// WORLD metres, exactly as Mn computes them.
export function islandDescriptor(cx, cz, seed) {
  const isHome = cx === 0 && cz === 0;
  const spans = [3200, 4000, 4800, 5400];
  const span = isHome
    ? 7200
    : spans[Math.floor(cellHash(cx, cz, 2, seed) * spans.length)];
  const half = span / 2;
  const jitterMax = Math.max(CELL_SIZE / 2 - half - 150, 0);
  const centreX =
    (cx + 0.5) * CELL_SIZE + (cellHash(cx, cz, 3, seed) * 2 - 1) * jitterMax - CELL_SIZE / 2;
  const centreZ =
    (cz + 0.5) * CELL_SIZE + (cellHash(cx, cz, 4, seed) * 2 - 1) * jitterMax - CELL_SIZE / 2;
  return {
    ix: cx,
    iz: cz,
    key: `${cx},${cz}`,
    cx: centreX,
    cz: centreZ,
    seed: Math.floor(cellHash(cx, cz, 9, seed) * 1e9) ^ seed,
    N: Math.round(span / GRID_CELL),
    cell: GRID_CELL,
    span,
    half,
    isHome,
  };
}

// ---------------------------------------------------------------------------
// The generator: island29's own kn, from the verbatim copies under ./gen/.
// ---------------------------------------------------------------------------

import { kn } from "./gen/terrain/part05.js";

// Wrap kn's world object as this module's grid record. The world object is
// kept whole (grid.world): its fields are island29's own per-texel data —
// h, type (1 = water), cdist (metres to nearest water ≤ 0), plain, ao, wet
// (inland-water cells), swamp (wetland ground 0..1), fresh (freshwater
// influence 0..1), level (water level per texel — 0 throughout this
// archipelago: every lake, river and marsh sits at sea level), nearLevel,
// lakeId (-1 none), body (0 land, 1 sea, 2 lake, 3 river, 4 tributary
// channel, 5 swamp, 6 estuary), sed, bankDist (metres to nearest bank),
// navMask, flowX/flowZ, accumulation, downstream, inl — plus the records:
// rivers[] {name, pts [x,z,…] island-local, levels[], …}, lakes[]
// {name, x, z, r, level, area, maxDepth, outlet}, marshes[] (same shape).
function wrapWorld(desc, w) {
  return {
    desc,
    N: w.N,
    cell: w.cell,
    half: w.half,
    span: desc.span,
    heights: w.h,
    cdist: w.cdist,
    plain: w.plain,
    ao: w.ao,
    type: w.type,
    wet: w.wet,
    swamp: w.swamp,
    fresh: w.fresh,
    level: w.level,
    nearLevel: w.nearLevel,
    lakeId: w.lakeId,
    body: w.body,
    sed: w.sed,
    bankDist: w.bankDist,
    navMask: w.navMask,
    flowX: w.flowX,
    flowZ: w.flowZ,
    accumulation: w.accumulation,
    downstream: w.downstream,
    inl: w.inl,
    tau: w.tau,
    dirX: w.dirX,
    dirZ: w.dirZ,
    rivers: w.rivers,
    lakes: w.lakes,
    marshes: w.marshes,
    maxHeight: w.maxHeight,
    landArea: w.landArea,
    name: w.name,
    world: w,
    seaDist: null, // filled lazily by seaDistance(grid)
  };
}

// kn with exactly the payload island29's worker receives (part09.js:
// postMessage({ seed, N, cell, isHome }) from island/part14.js's spec — the
// spec being Mn's descriptor, which islandDescriptor above reproduces).
function knFor(desc) {
  return kn({ seed: desc.seed, N: desc.N, cell: desc.cell, isHome: desc.isHome });
}

// generateIslandGrid(desc) — run island29's full generator synchronously.
// Returns the wrapped grid (see wrapWorld). Takes seconds (the home island,
// 720², is ~7-15 s in node); use the async variant on the main thread.
export function generateIslandGrid(desc) {
  const gen = knFor(desc);
  let r;
  while (!(r = gen.next()).done) {
    // progress yields are ignored on the synchronous path
  }
  return wrapWorld(desc, r.value);
}

// generateIslandGridAsync(desc, onProgress) — the same generator, pumped:
// awaits a macrotask whenever ~48 ms of work has passed so the browser can
// paint (the loading overlay shows kn's own stage labels via onProgress).
export async function generateIslandGridAsync(desc, onProgress) {
  const gen = knFor(desc);
  let r;
  let last = performance.now();
  while (!(r = gen.next()).done) {
    if (r.value && onProgress) onProgress(r.value);
    if (performance.now() - last > 48) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      last = performance.now();
    }
  }
  return wrapWorld(desc, r.value);
}

// ---------------------------------------------------------------------------
// Sampling. Texel-centre convention (kn's own): texel (col,row) centre is
// ((col+0.5)*cell-half, (row+0.5)*cell-half) in island-local metres.
// ---------------------------------------------------------------------------

// sampleIslandGrid(grid, lx, lz): bilinear height at island-local coords.
// Outside the grid: -40 (island29's deep-sea datum; kn's rim already falls
// to exactly this).
export function sampleIslandGrid(grid, lx, lz) {
  const { N, cell, half, heights } = grid;
  const fx = (lx + half) / cell - 0.5;
  const fz = (lz + half) / cell - 0.5;
  if (fx < 0 || fz < 0 || fx > N - 1 || fz > N - 1) return -40;
  const ix = Math.min(Math.floor(fx), N - 2);
  const iz = Math.min(Math.floor(fz), N - 2);
  const u = fx - ix;
  const v = fz - iz;
  const k = iz * N + ix;
  const top = heights[k] * (1 - u) + heights[k + 1] * u;
  const bottom = heights[k + N] * (1 - u) + heights[k + N + 1] * u;
  return top * (1 - v) + bottom * v;
}

// sampleIslandField(grid, field, lx, lz): bilinear sample of any continuous
// per-texel field of the wrapped grid (wet, swamp, fresh, sed, level, …).
// Outside the grid: 0.
export function sampleIslandField(grid, field, lx, lz) {
  const { N, cell, half } = grid;
  const fx = (lx + half) / cell - 0.5;
  const fz = (lz + half) / cell - 0.5;
  if (fx < 0 || fz < 0 || fx > N - 1 || fz > N - 1) return 0;
  const ix = Math.min(Math.floor(fx), N - 2);
  const iz = Math.min(Math.floor(fz), N - 2);
  const u = fx - ix;
  const v = fz - iz;
  const k = iz * N + ix;
  const top = field[k] * (1 - u) + field[k + 1] * u;
  const bottom = field[k + N] * (1 - u) + field[k + N + 1] * u;
  return top * (1 - v) + bottom * v;
}

// sampleIslandCode(grid, field, lx, lz): nearest-texel sample for coded
// fields (body, lakeId) where blending codes would be meaningless.
export function sampleIslandCode(grid, field, lx, lz) {
  const { N, cell, half } = grid;
  const ix = Math.round((lx + half) / cell - 0.5);
  const iz = Math.round((lz + half) / cell - 0.5);
  if (ix < 0 || iz < 0 || ix >= N || iz >= N) return 0;
  return field[iz * N + ix];
}

// seaDistance(grid): per-texel distance (metres) to the nearest SEA cell
// (body === 1), as a Float32Array over the island grid — island29's terrain
// colouring (part12) drives its freshwater-soil term from the distance to
// the sea coast specifically (its cdist in the shader is the signed sea
// distance), while kn's own cdist measures distance to ANY water (lakes and
// rivers included). Computed once per island with the same two-pass chamfer
// kn uses; cached on the grid.
export function seaDistance(grid) {
  if (grid.seaDist) return grid.seaDist;
  const { N, cell, body } = grid;
  const total = N * N;
  const dist = new Float32Array(total);
  for (let i = 0; i < total; i++) dist[i] = body[i] === 1 ? 0 : 1e9;
  const stepA = cell;
  const stepD = cell * Math.SQRT2;
  for (let row = 0; row < N; row++)
    for (let col = 0; col < N; col++) {
      const idx = row * N + col;
      let best = dist[idx];
      if (col > 0) best = Math.min(best, dist[idx - 1] + stepA);
      if (row > 0) best = Math.min(best, dist[idx - N] + stepA);
      if (col > 0 && row > 0) best = Math.min(best, dist[idx - N - 1] + stepD);
      if (col < N - 1 && row > 0) best = Math.min(best, dist[idx - N + 1] + stepD);
      dist[idx] = best;
    }
  for (let row = N - 1; row >= 0; row--)
    for (let col = N - 1; col >= 0; col--) {
      const idx = row * N + col;
      let best = dist[idx];
      if (col < N - 1) best = Math.min(best, dist[idx + 1] + stepA);
      if (row < N - 1) best = Math.min(best, dist[idx + N] + stepA);
      if (col < N - 1 && row < N - 1) best = Math.min(best, dist[idx + N + 1] + stepD);
      if (col > 0 && row < N - 1) best = Math.min(best, dist[idx + N - 1] + stepD);
      dist[idx] = best;
    }
  grid.seaDist = dist;
  return dist;
}
