          const dHere = 2.6 + 0.9 * smooth01(0, 260, seaDist);
          mouthPts.push({
            x: raw[i][0],
            z: raw[i][1],
            hw: wHere,
            d: dHere,
            spd: mouthSpd * Math.exp(-seaDist / 130),
          });
        }
      }
    }

    r._mouthPts = mouthPts;
    for (let i = 0; i + 1 < mouthPts.length; i++) {
      const a = mouthPts[i],
        b = mouthPts[i + 1];
      const isOffshore = i >= m - startIdx;
      const inlA = i < m - startIdx ? 1.0 : Math.max(0, 1.0 - (i - (m - startIdx)) * 0.15);
      const inlB = i + 1 < m - startIdx ? 1.0 : Math.max(0, 1.0 - (i + 1 - (m - startIdx)) * 0.15);
      carveSegment(a.x, a.z, b.x, b.z, a.hw, b.hw, a.d, b.d, a.spd, b.spd, {
        estuary: true,
        keepSea: true,
        bankFlare: isOffshore ? 2.4 : 1.55,
        inlTarget: [inlA, inlB],
      });
    }

    // Submarine bay fan: ensure ALL open sea cells across the entire bay in front of the
    // river mouth (without touching dry beaches/headlands) are deep enough for free navigation.
    const fanR = 340;
    const fx0 = Math.max(2, Math.floor((endX - fanR + half) / cell));
    const fx1 = Math.min(N - 3, Math.ceil((endX + fanR + half) / cell));
    const fz0 = Math.max(2, Math.floor((endZ - fanR + half) / cell));
    const fz1 = Math.min(N - 3, Math.ceil((endZ + fanR + half) / cell));
    const exitDX = endX - p[refIdx * 2],
      exitDZ = endZ - p[refIdx * 2 + 1];
    const exitL = Math.hypot(exitDX, exitDZ) || 1;
    const exU = exitDX / exitL,
      ezU = exitDZ / exitL;
    for (let iz = fz0; iz <= fz1; iz++) {
      const z = (iz + 0.5) * cell - half;
      for (let ix = fx0; ix <= fx1; ix++) {
        const k = iz * N + ix;
        if (h[k] >= -0.08) continue;
        // Keep a natural 1-cell beach-toe slope right next to dry sand
        if (
          h[k - 1] > 0.15 || h[k + 1] > 0.15 ||
          h[k - N] > 0.15 || h[k + N] > 0.15
        ) continue;
        const x = (ix + 0.5) * cell - half;
        const vx = x - endX,
          vz = z - endZ;
        const d = Math.hypot(vx, vz);
        if (d > fanR) continue;
        const forward = d < 25 ? 1 : (vx * exU + vz * ezU) / d;
        if (forward < -0.15) continue;
        const w = (1 - smooth01(fanR * 0.65, fanR, d)) * smooth01(-0.15, 0.25, forward);
        if (w <= 0.01) continue;
        const minBayH = -2.65 * w;
        if (h[k] > minBayH) {
          h[k] = minBayH;
          if (navMask && w > 0.45) navMask[k] = 1;
        }
      }
    }
  }

  // 3) The plume. Over the sea only, the inland mask is softened so the river's surface and the sea's cross-fade
  // without a seam. Fresh water itself stays wholly fresh, right to its banks.
  if (inl) {
    const tmp = new Float32Array(NN);
    for (let pass = 0; pass < 4; pass++) {
      tmp.set(inl);
      for (let iz = 1; iz < N - 1; iz++)
        for (let ix = 1; ix < N - 1; ix++) {
          const k = iz * N + ix;
          if (body[k] !== BODY_SEA || h[k] >= 0) continue;
          let sum = tmp[k] * 2,
            weight = 2;
          for (const q of [k - 1, k + 1, k - N, k + N]) {
            if (h[q] >= 0) continue;
            sum += tmp[q];
            weight++;
          }
          inl[k] = Math.min(0.98, Math.max(tmp[k] * 0.6, sum / weight));
        }
    }
  }
}

export function sculptRiverWaterlines(o) {
  const { N, cell, half, h, rivers, body, lakeId, wet, lakeSD, navMask } = o;
  if (!h || !N) return;
  const NN = N * N,
    SLOPE = 0.095,
    bandOut = cell * 2.4,
    minHalf = cell * 1.05,
    sd = new Float32Array(NN).fill(1e9),
    vtAt = new Float32Array(NN);

  const addSegSD = (C, P, bx, bz, hw0, hw1) => {
    const U = bx - C,
      V = bz - P,
      len2 = U * U + V * V || 1,
      reachR = Math.max(hw0, hw1, minHalf) + bandOut + cell,
      x0 = Math.max(0, Math.floor((Math.min(C, bx) - reachR + half) / cell)),
      x1 = Math.min(N - 1, Math.ceil((Math.max(C, bx) + reachR + half) / cell)),
      z0 = Math.max(0, Math.floor((Math.min(P, bz) - reachR + half) / cell)),
      z1 = Math.min(N - 1, Math.ceil((Math.max(P, bz) + reachR + half) / cell));
    for (let iz = z0; iz <= z1; iz++) {
      const z = (iz + 0.5) * cell - half;
      for (let ix = x0; ix <= x1; ix++) {
        const x = (ix + 0.5) * cell - half,
          t = clamp(((x - C) * U + (z - P) * V) / len2),
          d = Math.hypot(x - (C + U * t), z - (P + V * t)),
          vt = Math.max(mix(hw0, hw1, t), minHalf),
          s = d - vt,
          k = iz * N + ix;
        if (s < sd[k]) {
          sd[k] = s;
          vtAt[k] = vt;
        }
      }
    }
  };

  for (const r of rivers || []) {
    const p = r.pts,
      hw = r.hw,
      m = Math.min(hw.length, p.length / 2);
    for (let F = 0; F + 1 < m; F++) {
      addSegSD(p[F * 2], p[F * 2 + 1], p[F * 2 + 2], p[F * 2 + 3], hw[F], hw[F + 1]);
    }
    if (r._mouthPts) {
      for (let i = 0; i + 1 < r._mouthPts.length; i++) {
        const a = r._mouthPts[i],
          b = r._mouthPts[i + 1];
        addSegSD(a.x, a.z, b.x, b.z, a.hw, b.hw);
      }
    }
  }

  // 1) soften the carved channel core
  const inside = (k) =>
    sd[k] < -0.5 && wet[k] && h[k] < 0 && body[k] !== BODY_SEA && lakeId[k] < 0;
  const copy = new Float32Array(NN);
  for (let pass = 0; pass < 3; pass++) {
    copy.set(h);
    for (let iz = 1; iz < N - 1; iz++)
      for (let ix = 1; ix < N - 1; ix++) {
        const k = iz * N + ix;
        if (!inside(k)) continue;
        let acc = copy[k] * 4,
          wsum = 4;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const q = k + dz * N + dx;
            if (!inside(q)) continue;
            const w = dx && dz ? 1 : 2;
            acc += copy[q] * w;
            wsum += w;
          }
        const smoothed = Math.min(acc / wsum, -0.05);
        h[k] = navMask && navMask[k] ? Math.min(smoothed, -2.6) : smoothed;
      }
  }

  // 2) exact linear profile across the waterline — NEVER raising a navigable
  //    river-lake junction or river-sea mouth above navigable boat draft!
  const linIn = cell * 1.15,
    linOut = cell * 1.2,
    blend = cell * 0.7;
  const reshape = (k, s, halfWidth) => {
    const t = SLOPE * s;
    if (s < 0) {
      if (!wet[k] || h[k] >= 0) return;
      if (navMask && navMask[k]) {
        const l1 = Math.min(linIn * 0.55, halfWidth * 0.4),
          w = smooth01(l1, l1 + blend, -s);
        h[k] = Math.min(h[k], Math.min(t + (h[k] - t) * w, -2.5));
        return;
      }
      const l1 = Math.min(linIn, halfWidth * 0.75),
        w = smooth01(l1, l1 + blend, -s);
      h[k] = Math.min(t + (h[k] - t) * w, -0.004);
    } else {
      if (wet[k] || h[k] <= 0 || (navMask && navMask[k])) return;
      const w = smooth01(linOut, linOut + blend, s);
      h[k] = Math.max(t + (h[k] - t) * w, 0.004);
    }
  };
  const reach = linOut + blend;
  for (let k = 0; k < NN; k++) {
    const s = sd[k];
    if (s > reach || body[k] === BODY_SEA || lakeId[k] >= 0) continue;
    reshape(k, s, vtAt[k]);
  }
  if (lakeSD)
    for (let k = 0; k < NN; k++) {
      const s = lakeSD[k];
      if (s > reach || body[k] === BODY_SEA) continue;
      if (sd[k] < reach * 1.25 || (navMask && navMask[k])) continue;
      if (s < 0 && lakeId[k] < 0) continue;
      reshape(k, s, 1e9);
    }

  // 3) FINAL GUARANTEED BILINEAR BOAT FAIRWAY PASS:
  //    Walk every navigable river & its offshore mouth centerline at 3.5m intervals
  //    and guarantee every surrounding 2x2 bilinear cell stays <= -2.5m (depth >= 2.5m).
  const enforcePointDepth = (x, z, minDepth) => {
    const fx = (x + half) / cell - 0.5;
    const fz = (z + half) / cell - 0.5;
    const ix0 = Math.floor(fx),
      iz0 = Math.floor(fz);
    for (let dz = -1; dz <= 2; dz++) {
      for (let dx = -1; dx <= 2; dx++) {
        const ix = ix0 + dx,
          iz = iz0 + dz;
        if (ix < 1 || iz < 1 || ix >= N - 1 || iz >= N - 1) continue;
        const cx = (ix + 0.5) * cell - half;
        const cz = (iz + 0.5) * cell - half;
        const d = Math.hypot(cx - x, cz - z);
        if (d > cell * 1.45) continue;
        const k = iz * N + ix;
        const reqH = -minDepth * (1 - 0.35 * smooth01(cell * 0.65, cell * 1.45, d));
        if (h[k] > reqH) {
          h[k] = reqH;
          if (body[k] !== BODY_SEA) {
            wet[k] = 1;
            if (body[k] === BODY_LAND) body[k] = BODY_ESTUARY;
          }
          if (navMask) navMask[k] = 1;
        }
      }
    }
  };

  for (const r of rivers || []) {
    const isNav = r.navigable || r.outlet === "Sea" || r.kind === "main" || r.kind === "secondary";
    if (!isNav) continue;
    const p = r.pts,
      m = Math.min(r.hw.length, p.length / 2);
    for (let i = 0; i + 1 < m; i++) {
      const ax = p[i * 2], az = p[i * 2 + 1];
      const bx = p[i * 2 + 2], bz = p[i * 2 + 3];
      const segL = Math.hypot(bx - ax, bz - az) || 1;
      const steps = Math.max(1, Math.ceil(segL / 3.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        enforcePointDepth(mix(ax, bx, t), mix(az, bz, t), 2.5);
      }
    }
    if (r._mouthPts) {
      for (let i = 0; i + 1 < r._mouthPts.length; i++) {
        const a = r._mouthPts[i], b = r._mouthPts[i + 1];
        const segL = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const steps = Math.max(1, Math.ceil(segL / 3.5));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          enforcePointDepth(mix(a.x, b.x, t), mix(a.z, b.z, t), 2.8);
        }
      }
      delete r._mouthPts;
    }
  }
}

export function buildFreshwaterGeometry(world) {
  const position = [],
    water = [],
    edge = [],
    river = [],
    swamp = [],
    maskAttr = [];
  const n = world.N;
  const hasSwamp = !!world.swamp;
  const hasLake = !!world.lakeId; // The estuary mask, made safe at the banks. inl is 1 on fresh water and 0 on dry ground, so sampled bilinearly
// it used to fall away toward every bank: the surface faded out along the shore and took on its sea-mouth look
// there, leaving the shallows see-through. Dry cells now take the strongest mask of the water beside them, so
// the surface stays whole right up to the waterline and fades only where fresh water truly meets the sea.
const maskField = freshwaterCoverage(world);
  const sample = (x, z) => {
    const ix = Math.min(n - 2, Math.floor(x)),
      iz = Math.min(n - 2, Math.floor(z));
    const u = x - ix,
      v = z - iz,
      k = iz * n + ix;
    const at = (a) =>
      mix(mix(a[k], a[k + 1], u), mix(a[k + n], a[k + n + 1], u), v);
    const depth = -at(world.h);
    let lk = 0;
    if (hasLake) {
      const l00 = world.lakeId[k] >= 0 ? 1 : 0;
      const l10 = world.lakeId[k + 1] >= 0 ? 1 : 0;
      const l01 = world.lakeId[k + n] >= 0 ? 1 : 0;
      const l11 = world.lakeId[k + n + 1] >= 0 ? 1 : 0;
      lk = mix(mix(l00, l10, u), mix(l01, l11, u), v);
    }
    const swVal = hasSwamp ? at(world.swamp) : 0;
    // Open lakes stay purely crisp & crystalline even near low marsh margins
    const sw = clamp(swVal * (1 - lk * 0.88), 0, 1);
    return {
      x: (x + 0.5) * world.cell - world.half,
      z: (z + 0.5) * world.cell - world.half,
      depth,
      fx: at(world.flowX),
      fz: at(world.flowZ),
      sed: at(world.sed),
      mask: at(maskField),
      sw,
      lk,
    };
  };
  const interpolate = (a, b) => {
    const t = a.depth / (a.depth - b.depth);
    return Object.fromEntries(
      Object.keys(a).map((k) => [k, mix(a[k], b[k], t)]),
    );
  };
  const emit = (p) => {
    // Exact matched smoothstep(0.28, 0.90, p.mask) with ocean freshTakeover so
    // freshwater + sea sum smoothly to 1.0 with zero seam across every estuary mouth!
    const mouthFade = smooth01(0.28, 0.90, p.mask);
    // Feather vertical offset gently from 0.008 inland to 0.001 at the sea mouth
    const yLevel = 0.001 + 0.007 * mouthFade;
    position.push(p.x, yLevel, p.z);
    water.push(p.fx, p.fz, Math.max(0.001, p.depth), p.sed);
    // Coverage is not depth: interpolating a zero at the bank fades an entire 5 m triangle.
    // The fragment shader handles the millimetre-scale contact feather instead.
    edge.push(mouthFade);
    river.push(clamp((Math.hypot(p.fx, p.fz) - 0.04) / 0.30));
    swamp.push(p.sw, p.lk);
    maskAttr.push(mouthFade);
  };
  for (let z = 0; z < n - 1; z++)
    for (let x = 0; x < n - 1; x++) {
      const k = z * n + x;
      if (
        Math.max(
          maskField[k],
          maskField[k + 1],
          maskField[k + n],
          maskField[k + n + 1],
        ) < 0.285
      )
        continue;
      if (
        Math.min(
          world.h[k],
          world.h[k + 1],
          world.h[k + n],
          world.h[k + n + 1],
        ) >= 0
      )
        continue;
      for (let sz = 0; sz < 2; sz++)
        for (let sx = 0; sx < 2; sx++) {
          const a = sample(x + sx / 2, z + sz / 2),
            b = sample(x + (sx + 1) / 2, z + sz / 2);
          const c = sample(x + sx / 2, z + (sz + 1) / 2),
            d = sample(x + (sx + 1) / 2, z + (sz + 1) / 2);
          for (const tri of [
            [a, c, b],
            [b, c, d],
          ]) {
            const poly = [];
            for (let i = 0; i < 3; i++) {
              const p = tri[i],
                q = tri[(i + 1) % 3];
              if (p.depth >= 0) poly.push(p);
              if (p.depth >= 0 !== q.depth >= 0) poly.push(interpolate(p, q));
            }
            for (let i = 1; i < poly.length - 1; i++) {
              emit(poly[0]);
              emit(poly[i]);
              emit(poly[i + 1]);
            }
          }
        }
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("aWater", new Float32BufferAttribute(water, 4));
  geometry.setAttribute("aEdge", new Float32BufferAttribute(edge, 1));
  geometry.setAttribute("aRiver", new Float32BufferAttribute(river, 1));
  geometry.setAttribute("aSwamp", new Float32BufferAttribute(swamp, 2));
  geometry.setAttribute("aMask", new Float32BufferAttribute(maskAttr, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
