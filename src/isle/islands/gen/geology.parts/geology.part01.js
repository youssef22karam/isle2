/* =============================================================================
   geology.js — Breathtaking Tropical Karst Mountains, Coastal Rocky Hills with
   Green Cover, Sea Stacks, Lake Mountain Amphitheaters & River Gorge Bluffs.
   Shared identically by both main-thread (island/) and worker (terrain/) builds.
============================================================================= */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth01 = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function mulberry32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed) {
  const s0 = seed | 0;
  const hash = (ix, iz) => {
    let n = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + s0) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  };
  const val = (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz), b = hash(ix + 1, iz);
    const c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x, z, oct = 4) => {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += (val(x * freq + i * 19.3, z * freq - i * 11.7) * 2 - 1) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.04;
    }
    return sum / norm;
  };
  const ridged = (x, z, oct = 4) => {
    let sum = 0, amp = 0.5, freq = 1, weight = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      let signal = 1 - Math.abs(val(x * freq + i * 23.1, z * freq + i * 13.7) * 2 - 1);
      signal = signal * signal * weight;
      weight = clamp(signal * 1.85, 0, 1);
      sum += signal * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.11;
    }
    return sum / norm;
  };
  return { val, fbm, ridged };
}

/**
 * Sculpts dramatic craggy rocky mountains with green terraces, coastal karst
 * hills & sea stacks on beaches, lake amphitheater peaks, and river valley bluffs,
 * while strictly preserving every river, lake, wetland, and estuary fairway.
 */
export function sculptBreathtakingGeology(ctx) {
  const {
    N,
    cell,
    half,
    h,
    wet,
    cdist,
    rivers = [],
    lakes = [],
    marshes = [],
    swamp,
    seed,
    isHome,
  } = ctx;
  if (!h || !N) return;

  const NN = N * N;
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const nz = makeNoise((seed ^ 0x85ebca6b) | 0);
  const nz2 = makeNoise((seed ^ 0xc2b2ae35) | 0);

  const xOf = (ix) => (ix + 0.5) * cell - half;
  const zOf = (iz) => (iz + 0.5) * cell - half;
  const idxAt = (x, z) => {
    const ix = Math.round((x + half) / cell - 0.5);
    const iz = Math.round((z + half) / cell - 0.5);
    if (ix < 1 || iz < 1 || ix >= N - 1 || iz >= N - 1) return -1;
    return iz * N + ix;
  };

  // Collect river mouths and precompute distance-to-river-corridor field so
  // no karst cliff or mountain spur ever blocks a river or estuary mouth.
  const mouths = [];
  const riverClear = new Float32Array(NN).fill(1e9);
  const riverCurvSign = new Float32Array(NN);

  for (const r of rivers) {
    const pts = r.pts;
    const hw = r.hw;
    const m = Math.min(hw.length, pts.length / 2);
    if (m < 2) continue;
    if (r.outlet === "Sea" || r.bodyKind === 6) {
      const ex = pts[(m - 1) * 2], ez = pts[(m - 1) * 2 + 1];
      const rx = ex - pts[Math.max(0, m - 5) * 2];
      const rz = ez - pts[Math.max(0, m - 5) * 2 + 1];
      const rl = Math.hypot(rx, rz) || 1;
      mouths.push({ x: ex, z: ez, dx: rx / rl, dz: rz / rl });
    }
    const band = 290;
    for (let i = 0; i + 1 < m; i++) {
      const ax = pts[i * 2], az = pts[i * 2 + 1];
      const bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      const len = Math.sqrt(len2);
      const wMax = Math.max(hw[i] || 12, hw[i + 1] || 12);
      const reach = wMax + band;
      const x0 = Math.max(1, Math.floor((Math.min(ax, bx) - reach + half) / cell));
      const x1 = Math.min(N - 2, Math.ceil((Math.max(ax, bx) + reach + half) / cell));
      const z0 = Math.max(1, Math.floor((Math.min(az, bz) - reach + half) / cell));
      const z1 = Math.min(N - 2, Math.ceil((Math.max(az, bz) + reach + half) / cell));
      let curv = 0;
      if (i > 0 && i + 2 < m) {
        const ux = ax - pts[(i - 1) * 2], uz = az - pts[(i - 1) * 2 + 1];
        const vx = pts[(i + 2) * 2] - bx, vz = pts[(i + 2) * 2 + 1] - bz;
        curv = Math.sign(ux * vz - uz * vx);
      }
      for (let iz = z0; iz <= z1; iz++) {
        const z = zOf(iz);
        for (let ix = x0; ix <= x1; ix++) {
          const x = xOf(ix);
          const t = clamp(((x - ax) * dx + (z - az) * dz) / len2);
          const px = ax + dx * t, pz = az + dz * t;
          const dist = Math.hypot(x - px, z - pz) - mix(hw[i] || 12, hw[i + 1] || 12, t);
          const k = iz * N + ix;
          if (dist < riverClear[k]) {
            riverClear[k] = dist;
            const side = Math.sign((x - px) * dz - (z - pz) * dx);
            riverCurvSign[k] = curv * side; // >0 on outer bend where bluffs naturally form
          }
        }
      }
    }
  }

  const nearMouth = (x, z, pad = 210) => {
    for (const m of mouths) {
      for (let s = -40; s <= 420; s += 45) {
        const mx = m.x + m.dx * s, mz = m.z + m.dz * s;
        if (Math.hypot(x - mx, z - mz) < pad) return true;
      }
    }
    return false;
  };

  const nearMarsh = (x, z, pad = 80) => {
    for (const m of marshes) {
      if (Math.hypot(x - m.x, z - m.z) < m.r * 1.35 + pad) return true;
    }
    return false;
  };

  const marshFade = (x, z) => {
    let f = 1;
    for (const m of marshes) {
      const r = Math.max(m.r || 180, 180);
      f = Math.min(f, smooth01(r * 1.35, r * 2.25, Math.hypot(x - m.x, z - m.z)));
    }
    return f;
  };

  // ---------------------------------------------------------------------------
  // 1) INTERIOR CRAGGY ROCKY MOUNTAINS WITH HANGING GREEN TERRACES
  // ---------------------------------------------------------------------------
  for (let iz = 2; iz < N - 2; iz++) {
    const z = zOf(iz);
    for (let ix = 2; ix < N - 2; ix++) {
      const k = iz * N + ix;
      const baseH = h[k];
      if (wet[k] || baseH <= 14) continue;
      const x = xOf(ix);

      const rivSafe = smooth01(24, 95, riverClear[k]);
      if (rivSafe <= 0.001) continue;
      const swSafe = swamp ? 1 - smooth01(0.18, 0.5, swamp[k]) : 1;
      let lakeSafe = 1;
      for (const lk of lakes) {
        const dl = Math.hypot(x - lk.x, z - lk.z) / Math.max(lk.r, 1);
        lakeSafe = Math.min(lakeSafe, smooth01(1.06, 1.35, dl));
      }
      const mask = rivSafe * swSafe * lakeSafe * marshFade(x, z);
      if (mask <= 0.01) continue;

      // Domain-warped craggy ridges + watershed mountain chains across ALL sectors of the island
      const wx = x + nz.fbm(x / 360, z / 360, 3) * 85;
      const wz = z + nz2.fbm(x / 360 + 7.1, z / 360 - 4.3, 3) * 85;
      const cragMacro = nz.ridged(wx / 490, wz / 490, 4);
      const cragMeso = nz2.ridged(wx / 175 + 3.7, wz / 175 - 2.9, 3);
      // Lift watershed divides even in lower sectors (baseH > 8m & cdist > 140m) into dramatic rocky ranges!
      const divideMask = smooth01(8, 52, baseH) * smooth01(110, 340, cdist[k]) * smooth01(55, 195, riverClear[k]);
      const upWeight = Math.max(smooth01(16, 88, baseH), divideMask * 0.88);

      const spire = (Math.pow(cragMacro, 1.32) * 118 + Math.pow(cragMeso, 1.4) * 34) * upWeight;

      // Stepped cliff-and-ledge terrace modulation: sheer rock risers + lush flat green benches
      const stepPeriod = 36 + 14 * nz.val(x / 520, z / 520);
      const totalH = baseH + spire * 0.65;
      const phase = totalH / stepPeriod;
      const frac = phase - Math.floor(phase);
      const shaped = frac < 0.38
        ? (frac / 0.38) * 0.77
        : 0.77 + ((frac - 0.38) / 0.62) * 0.23;
      const terrace = ((Math.floor(phase) + shaped) * stepPeriod - totalH) * 0.42 * smooth01(24, 95, totalH);

      h[k] = baseH + (spire + terrace) * mask;
    }
  }

  // ---------------------------------------------------------------------------
  // 2) MAJESTIC MOUNTAINS & CRAGGY CLIFF HEADLANDS AROUND LAKES
  // ---------------------------------------------------------------------------
  for (let li = 0; li < lakes.length; li++) {
    const lk = lakes[li];
    const R = Math.max(lk.r, 85);
    const reach = R * 3.7;
    const x0 = Math.max(2, Math.floor((lk.x - reach + half) / cell));
    const x1 = Math.min(N - 3, Math.ceil((lk.x + reach + half) / cell));
    const z0 = Math.max(2, Math.floor((lk.z - reach + half) / cell));
    const z1 = Math.min(N - 3, Math.ceil((lk.z + reach + half) / cell));
    const peakAngle = rnd() * Math.PI * 2;

    for (let iz = z0; iz <= z1; iz++) {
      const z = zOf(iz);
      for (let ix = x0; ix <= x1; ix++) {
        const k = iz * N + ix;
        if (wet[k] || h[k] <= 0.4) continue;
        const x = xOf(ix);
        const dx = x - lk.x, dz = z - lk.z;
        const distR = Math.hypot(dx, dz) / R;
        if (distR < 1.07 || distR > 3.65) continue;

        const rivSafe = smooth01(30, 130, riverClear[k]);
        if (rivSafe <= 0.01) continue;
        const swSafe = swamp ? 1 - smooth01(0.2, 0.55, swamp[k]) : 1;
        const coastSafe = smooth01(35, 140, cdist[k]);

        // Multi-peak alpine/karst amphitheater ringing the lake with sunny coves between spurs
        const ang = Math.atan2(dz, dx);
        const crown = 0.56 + 0.44 * Math.cos(ang * 2 - peakAngle) * Math.cos(ang - peakAngle * 0.5 + 0.8);
        const coveGate = smooth01(0.14, 0.68, crown + nz.fbm(x / 220, z / 220, 2) * 0.30);
        if (coveGate <= 0.01) continue;

        const ring = smooth01(1.09, 1.78, distR) * (1 - smooth01(2.45, 3.62, distR));
        const bluffRing = smooth01(1.07, 1.30, distR) * (1 - smooth01(1.48, 1.95, distR))
          * smooth01(0.48, 0.82, nz2.val(x / 135 + li * 7.3, z / 135));

        const ridge = nz.ridged((x + li * 131) / 310, (z - li * 97) / 310, 4);
        const crag = nz2.ridged(x / 115, z / 115, 3);
        const lift = (ring * (68 + 158 * Math.pow(ridge, 1.2) + 36 * crag)
          + bluffRing * (34 + 44 * crag)) * coveGate * (0.45 + 0.55 * coastSafe);

        const stepP = 30;
        const ph = (h[k] + lift) / stepP;
        const fr = ph - Math.floor(ph);
        const ledge = ((Math.floor(ph) + (fr < 0.40 ? (fr / 0.40) * 0.78 : 0.78 + ((fr - 0.40) / 0.60) * 0.22)) * stepP - (h[k] + lift)) * 0.36;

        h[k] += (lift + ledge) * rivSafe * swSafe * marshFade(x, z);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3) SCENIC RIVER GORGES, ROCKY OUTER-BEND BLUFFS & TERRACED GREEN HILLS
  // ---------------------------------------------------------------------------
  for (let iz = 2; iz < N - 2; iz++) {
    const z = zOf(iz);
    for (let ix = 2; ix < N - 2; ix++) {
      const k = iz * N + ix;
      if (wet[k] || h[k] <= 0.35) continue;
      const rc = riverClear[k];
      if (rc < 18 || rc > 295) continue;
      const x = xOf(ix);
      if (nearMouth(x, z, 150)) continue;
      const swSafe = swamp ? 1 - smooth01(0.16, 0.42, swamp[k]) : 1;
      if (swSafe <= 0.02) continue;

      let lakeSafe = 1;
      for (const lk of lakes) {
        lakeSafe = Math.min(lakeSafe, smooth01(lk.r * 1.15, lk.r * 1.55, Math.hypot(x - lk.x, z - lk.z)));
      }
      if (lakeSafe <= 0.02) continue;

      const alongMask = smooth01(-0.14, 0.38, nz.fbm(x / 320 + 11.2, z / 320 - 6.4, 3));
      const outerBoost = riverCurvSign[k] > 0 ? 1.38 : 0.82;
      const coastalFade = smooth01(45, 200, cdist[k]);

      const bluffProfile = smooth01(18, 72, rc) * (1 - smooth01(170, 290, rc));
      const crag = nz.ridged(x / 185 + 4.2, z / 185 - 8.1, 4);
      const meso = nz2.ridged(x / 78, z / 78, 3);

      let addH = bluffProfile * (34 + 88 * Math.pow(crag, 1.2) + 22 * meso)
        * alongMask * outerBoost * (0.42 + 0.58 * coastalFade);

      if (addH > 10) {
        const sp = 24;
        const ph = (h[k] + addH) / sp;
        const fr = ph - Math.floor(ph);
        const flatTop = fr < 0.42 ? (fr / 0.42) * 0.80 : 0.80 + ((fr - 0.42) / 0.58) * 0.20;
        addH += ((Math.floor(ph) + flatTop) * sp - (h[k] + addH)) * 0.40;
      }

      h[k] += addH * swSafe * lakeSafe * marshFade(x, z);
    }
  }

  // ---------------------------------------------------------------------------
  // 4) ELONGATED JAGGED COASTAL KARST PROMONTORIES & TRAILING SEA STACKS
  //    (Natural multi-spired limestone headlands on beaches + lagoon islets!)
  // ---------------------------------------------------------------------------
  const karsts = [];
  const spines = [];
  const targetPromontories = isHome ? 18 : N >= 480 ? 12 : 9;

  for (let attempt = 0; attempt < 950 && spines.length < targetPromontories; attempt++) {
    const ang = rnd() * Math.PI * 2;
    const dist = half * (0.22 + rnd() * 0.68);
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    const k = idxAt(x, z);
    if (k < 0 || wet[k]) continue;
    const hk = h[k];
    const cd = cdist[k];
    if (hk < -0.5 || hk > 18 || cd > 90) continue;
    if (riverClear[k] < 105 || nearMouth(x, z, 220) || nearMarsh(x, z, 100)) continue;
    if (spines.some((p) => Math.hypot(x - p.x, z - p.z) < 290)) continue;

    // Orient promontory ridge roughly outward from the island interior toward the beach/sea
    const gx = (h[Math.min(N - 1, (k % N) + 2) + ((k / N) | 0) * N] - h[Math.max(0, (k % N) - 2) + ((k / N) | 0) * N]);
    const gz = (h[Math.min(N - 1, ((k / N) | 0) + 2) * N + (k % N)] - h[Math.max(0, ((k / N) | 0) - 2) * N + (k % N)]);
    const outAng = Math.atan2(-gz, -gx) + (rnd() - 0.5) * 0.75;
    const ux = Math.cos(outAng), uz = Math.sin(outAng);
    const scale = clamp(N / 640, 0.78, 1.08);
    const mainH = 42 + Math.pow(rnd(), 0.7) * 76; // 42m..118m dramatic coastal karst massif!
    spines.push({ x, z });

    // Chain of 3..4 overlapping elongated craggy lobes forming an organic rocky headland ridge
    const lobes = 3 + ((rnd() * 2) | 0);
    for (let li = 0; li < lobes; li++) {
      const along = (li - 1.1) * (42 + rnd() * 24) * scale;
      const side = (rnd() - 0.5) * 26 * scale;
      const lx = x + ux * along - uz * side;
      const lz = z + uz * along + ux * side;
      const lk2 = idxAt(lx, lz);
      if (lk2 < 0 || riverClear[lk2] < 75 || nearMouth(lx, lz, 185)) continue;
      const rLong = (56 + rnd() * 48) * scale * (1 - li * 0.12);
      const rWide = rLong * (0.36 + rnd() * 0.22);
      const lobeH = mainH * (li === 1 ? 1.0 : li === 0 ? 0.82 : 0.68 - (li - 2) * 0.18) * (0.85 + rnd() * 0.25);
      karsts.push({
        x: lx,
        z: lz,
        rx: rLong,
        rz: rWide,
        peakH: lobeH,
        rot: outAng + (rnd() - 0.5) * 0.45,
        stack: false,
      });
    }

    // Optional trailing sea stack in the turquoise bay off the tip of the headland (like Image 3!)
    if (rnd() < 0.72) {
      const tipDist = (95 + rnd() * 65) * scale;
      const sx = x + ux * tipDist + (rnd() - 0.5) * 32;
      const sz = z + uz * tipDist + (rnd() - 0.5) * 32;
      const sk = idxAt(sx, sz);
      if (sk >= 0 && h[sk] < -0.4 && h[sk] > -3.8 && !nearMouth(sx, sz, 240) && riverClear[sk] > 120) {
        const sr = 24 + rnd() * 24;
        karsts.push({
          x: sx,
          z: sz,
          rx: sr * (1.1 + rnd() * 0.35),
          rz: sr * (0.58 + rnd() * 0.28),
          peakH: 18 + rnd() * 32,
          rot: outAng + (rnd() - 0.5) * 0.9,
          stack: true,
        });
      }
    }
  }

  // Stamp elongated jagged karst headlands & sea stacks with fluted cliff walls + lush green summit crowns
  for (let ki = 0; ki < karsts.length; ki++) {
    const K = karsts[ki];
    const ca = Math.cos(K.rot), sa = Math.sin(K.rot);
    const maxR = Math.max(K.rx, K.rz) * 1.45;
    const x0 = Math.max(2, Math.floor((K.x - maxR + half) / cell));
    const x1 = Math.min(N - 3, Math.ceil((K.x + maxR + half) / cell));
    const z0 = Math.max(2, Math.floor((K.z - maxR + half) / cell));
    const z1 = Math.min(N - 3, Math.ceil((K.z + maxR + half) / cell));

    for (let iz = z0; iz <= z1; iz++) {
      const z = zOf(iz);
      for (let ix = x0; ix <= x1; ix++) {
        const k = iz * N + ix;
        if (riverClear[k] < 50) continue;

        const x = xOf(ix);
        const dx = x - K.x, dz = z - K.z;
        const lx = dx * ca + dz * sa;
        const lz = -dx * sa + dz * ca;

        // Strongly jagged domain-warped ridge contour (never circular!)
        const warp = nz.fbm(x / 34 + ki * 5.7, z / 34 - ki * 3.1, 3) * 0.28
          + (nz2.ridged(x / 24 + ki * 2.1, z / 24, 2) - 0.5) * 0.18;
        const rho = Math.hypot(lx / K.rx, lz / K.rz) + warp;
        if (rho >= 1.06) continue;

        // Steep limestone cliff flanks + undulating green-draped ridge/summit cap
        const wall = Math.pow(clamp((1.02 - rho) / 0.48, 0, 1), 0.56);
        const bench = smooth01(0.86, 0.72, rho) * (1 - smooth01(0.60, 0.46, rho));
        const cragTop = 0.80 + 0.30 * nz.ridged(x / 36 + ki * 7, z / 36, 3)
          + 0.14 * nz2.fbm(x / 19, z / 19, 2);

        let targetY = K.peakH * wall * cragTop - bench * K.peakH * 0.11;
        if (!K.stack) {
          const base = Math.max(h[k], 0);
          targetY = base * (1 - smooth01(0.68, 1.02, 1.04 - rho)) + targetY;
        }
        if (targetY > h[k]) {
          h[k] = targetY;
          if (h[k] > 0 && wet[k]) wet[k] = 0;
        }
      }
    }
  }

  ctx.karsts = karsts;
}

/**
 * Deterministic 3D coastal limestone boulder clusters, sea-stack & karst hill
 * lush green canopy crowns, tropical beach palm groves, and lake/river bluff rocks.
 * Never places obstacles in navigable boat channels (navMask or h < -0.35).
 */
export function scatterKarstAndCoastalProps(world, out, defs) {
  if (!world || !out || !defs) return;
  const { N, cell, half, h, wet, cdist, fresh, swamp, navMask, nearLevel } = world;
  const rnd = mulberry32((world.seed ^ 0x6a09e667) >>> 0);
  const nz = makeNoise((world.seed ^ 0xbb67ae85) | 0);
  const TAU = Math.PI * 2;
  // Cell centres in island metres. These were only ever defined inside sculptBreathtakingGeology, so every
  // use below threw a ReferenceError that took the whole forest down with it: no island grew any flora.
  const xOf = (ix) => (ix + 0.5) * cell - half;
  const zOf = (iz) => (iz + 0.5) * cell - half;

  const sampleH = (x, z) => {
    const fx = (x + half) / cell - 0.5;
    const fz = (z + half) / cell - 0.5;
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return -40;
    const ix = fx | 0, iz = fz | 0;
    const u = fx - ix, v = fz - iz;
    const k = iz * N + ix;
    return (h[k] * (1 - u) + h[k + 1] * u) * (1 - v)
      + (h[k + N] * (1 - u) + h[k + N + 1] * u) * v;
  };

  const footH = (x, z, r) => {
    let minH = sampleH(x, z);
    if (r <= 0) return minH;
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * TAU;
      minH = Math.min(minH, sampleH(x + Math.cos(ang) * r, z + Math.sin(ang) * r));
    }
    return minH;
  };

  const cellAt = (x, z) => {
    const ix = Math.round((x + half) / cell - 0.5);
    const iz = Math.round((z + half) / cell - 0.5);
    return ix < 1 || iz < 1 || ix >= N - 1 || iz >= N - 1 ? -1 : iz * N + ix;
  };

  const isNavBlocked = (x, z, rad = 12) => {
    if (!navMask) return false;
    const steps = Math.max(1, Math.ceil(rad / cell));
    const ix0 = Math.round((x + half) / cell - 0.5);
    const iz0 = Math.round((z + half) / cell - 0.5);
    for (let dz = -steps; dz <= steps; dz++) {
      for (let dx = -steps; dx <= steps; dx++) {
        const ix = ix0 + dx, iz = iz0 + dz;
        if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
        if (navMask[iz * N + ix]) return true;
      }
    }
    return false;
  };

  const emit = (kind, variant, x, y, z, sx, sy, sz, yaw, pitch, roll, r, g, b) => {
    const arr = out[kind];
    if (!arr || !arr.length) return;
    const bucket = arr[Math.abs(variant | 0) % arr.length];
    const cy = Math.cos(yaw * 0.5), syw = Math.sin(yaw * 0.5);
    const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
    const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
    // YXZ Euler quaternion matching Three.js default
    const qx = cy * sp * cr + syw * cp * sr;
    const qy = syw * cp * cr - cy * sp * sr;
    const qz = cy * cp * sr - syw * sp * cr;
    const qw = cy * cp * cr + syw * sp * sr;
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    bucket.matrices.push(
      (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
      (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
      (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
      x, y, z, 1,
    );
    bucket.colors.push(r, g, b);
  };

  const hslToRgb = (hVal, sVal, lVal) => {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = lVal < 0.5 ? lVal * (1 + sVal) : lVal + sVal - lVal * sVal;
    const p = 2 * lVal - q;
    return [hue2rgb(p, q, hVal + 1 / 3), hue2rgb(p, q, hVal), hue2rgb(p, q, hVal - 1 / 3)];
  };

  // ---------------------------------------------------------------------------
  // A) PALE WEATHERED COASTAL LIMESTONE BOULDER CLUSTERS & TROPICAL BEACH PALMS
  // ---------------------------------------------------------------------------
  for (let iz = 3; iz < N - 3; iz += 2) {
    for (let ix = 3; ix < N - 3; ix += 2) {
      const k = iz * N + ix;
      const hk = h[k];
      const cd = cdist[k];
      if (hk < -0.45 || hk > 38 || cd > 155) continue;

      const x = xOf(ix) + (rnd() - 0.5) * cell * 1.6;
      const z = zOf(iz) + (rnd() - 0.5) * cell * 1.6;
      if (isNavBlocked(x, z, 18)) continue;

      const y = sampleH(x, z);
      const gx = (sampleH(x + 4, z) - sampleH(x - 4, z)) / 8;
      const gz = (sampleH(x, z + 4) - sampleH(x, z - 4)) / 8;
      const slope = Math.hypot(gx, gz);
      const sw = swamp ? swamp[k] : 0;
      const fr = fresh ? fresh[k] : 0;

      // 1) Sculpted pale-grey coastal limestone boulder clusters right at the shoreline / headland toes
      const rockField = nz.val(x / 54 + 3.1, z / 54 - 7.7);
      if (cd < 52 && y > -0.35 && y < 6.5 && sw < 0.25 && (slope > 0.22 || rockField > 0.66)) {
        if (rnd() < (slope > 0.35 ? 0.34 : 0.14)) {
          const count = 2 + ((rnd() * 4) | 0);
          const baseScale = 1.6 + Math.pow(rnd(), 0.7) * (slope > 0.35 ? 4.2 : 2.6);
          for (let b = 0; b < count; b++) {
            const ang = rnd() * TAU;
            const rad = b === 0 ? 0 : baseScale * (0.45 + rnd() * 1.15);
            const bx = x + Math.cos(ang) * rad;
            const bz = z + Math.sin(ang) * rad;
            if (isNavBlocked(bx, bz, 14)) continue;
            const s = b === 0 ? baseScale : baseScale * (0.35 + rnd() * 0.62);
            const fy = footH(bx, bz, s * 0.38);
            if (fy < -0.85) continue;
            // Sun-bleached pale coastal limestone / warm granite tones (like Images 3, 4, 5!)
            const tone = 0.46 + rnd() * 0.18;
            const warm = 0.96 + rnd() * 0.08;
            emit(
              rnd() < 0.32 ? "slab" : "rock",
              (rnd() * 12) | 0,
              bx,
              fy - s * 0.08,
              bz,
              s * (0.95 + rnd() * 0.38),
              s * (0.68 + rnd() * 0.62),
              s * (0.88 + rnd() * 0.36),
              rnd() * TAU,
              (rnd() - 0.5) * 0.28,
              (rnd() - 0.5) * 0.28,
              tone * warm,
              tone * 0.99,
              tone * 0.93,
            );
            // Crown larger coastal boulders with clinging green coastal shrubs/ferns!
            if (s > 2.2 && fy > 1.2 && rnd() < 0.68) {
              const [cr, cg, cb] = hslToRgb(0.24 + rnd() * 0.05, 0.46, 0.36 + rnd() * 0.1);
              const shS = 0.65 + rnd() * 0.75;
              emit(
                rnd() < 0.42 ? "fern" : "shrub",
                (rnd() * 8) | 0,
                bx + (rnd() - 0.5) * s * 0.35,
                fy + s * 0.42,
                bz + (rnd() - 0.5) * s * 0.35,
                shS,
                shS * 0.9,
                shS,
                rnd() * TAU,
                0,
                0,
                cr,
                cg,
                cb,
              );
            }
          }
        }
      }

      // 2) Lush green canopy & shrub crowns on coastal rocky hills, cliffs & sea stacks!
      if (cd < 155 && y > 4.2 && slope < 0.72) {
        // Check if this cell sits on or near a steep rocky coastal hill / sea stack
        const hMaxNear = Math.max(
          sampleH(x + 16, z), sampleH(x - 16, z),
          sampleH(x, z + 16), sampleH(x, z - 16),
        );
        const hMinNear = Math.min(
          sampleH(x + 18, z), sampleH(x - 18, z),
          sampleH(x, z + 18), sampleH(x, z - 18),
        );
        const relief = hMaxNear - hMinNear;
        if (relief > 8.5 && rnd() < 0.46) {
          const [cr, cg, cb] = hslToRgb(0.25 + rnd() * 0.05, 0.45, 0.34 + rnd() * 0.14);
          if (slope < 0.46 && rnd() < 0.52) {
            const ts = 0.72 + rnd() * 0.68;
            emit(
              rnd() < 0.28 ? "palm" : "broadleaf",
              (rnd() * 8) | 0,
              x,
              y - 0.22,
              z,
              ts,
              ts * (0.85 + rnd() * 0.3),
              ts,
              rnd() * TAU,
              (rnd() - 0.5) * 0.08,
              (rnd() - 0.5) * 0.08,
              cr,
              cg,
              cb,
            );
          }
          const shCount = 1 + ((rnd() * 3) | 0);
          for (let s = 0; s < shCount; s++) {
            const sx = x + (rnd() - 0.5) * 8;
            const sz = z + (rnd() - 0.5) * 8;
            const sy = sampleH(sx, sz);
            if (sy < 2.2) continue;
            const sc = 0.68 + rnd() * 0.85;
            emit(
              rnd() < 0.35 ? "fern" : "shrub",
              (rnd() * 8) | 0,
              sx,
              sy - 0.1,
              sz,
              sc,
              sc * 0.92,
              sc,
              rnd() * TAU,
              (rnd() - 0.5) * 0.12,
              (rnd() - 0.5) * 0.12,
              cr * 1.04,
              cg * 1.06,
              cb * 0.96,
            );
          }
        }
      }

      // 3) Picturesque tropical beach palm & lush green coastal bush clusters along sandy beaches
      const groveN = nz.val(x / 68 - 5.2, z / 68 + 4.4);
      if (cd < 68 && y > 1.15 && y < 4.8 && slope < 0.24 && sw < 0.2 && fr < 0.45 && groveN > 0.56) {
        if (rnd() < 0.24) {
          // Leaning coconut palm + lush green beach ferns/shrubs at its foot (Images 3, 4, 5!)
          const seaYaw = Math.atan2(-gz, -gx) + (rnd() - 0.5) * 0.85;
          const ps = 0.88 + rnd() * 0.68;
          const [pr, pg, pb] = hslToRgb(0.24 + rnd() * 0.03, 0.44, 0.40 + rnd() * 0.07);
          emit(
            "palm",
            (rnd() * 4) | 0,
            x,
            y - 0.18,
            z,
            ps,
            ps * (0.9 + rnd() * 0.25),
            ps,
            seaYaw,
            0.12 + rnd() * 0.14,
            (rnd() - 0.5) * 0.12,
            pr,
            pg,
            pb,
          );
          const underN = 2 + ((rnd() * 3) | 0);
          for (let u = 0; u < underN; u++) {
            const ux = x + (rnd() - 0.5) * 5.2;
            const uz = z + (rnd() - 0.5) * 5.2;
            const uy = sampleH(ux, uz);
            if (uy < 0.85) continue;
            const us = 0.62 + rnd() * 0.68;
            const [ur, ug, ub] = hslToRgb(0.25 + rnd() * 0.04, 0.48, 0.36 + rnd() * 0.1);
            emit(
              u % 2 === 0 ? "fern" : "shrub",
