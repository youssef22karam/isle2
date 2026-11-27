// Both surfaces must sample the same field, including the dry side of a bank.
const fields = new WeakMap();

export function freshwaterTakeover(value) {
  const t = Math.max(0, Math.min(1, (value - 0.28) / 0.62));
  return t * t * (3 - 2 * t);
}

export function freshwaterCoverage(world) {
  if (fields.has(world)) return fields.get(world);
  const { N, h, wet, inl } = world;
  const mask = new Float32Array(N * N);
  for (let k = 0; k < mask.length; k++) {
    mask[k] = wet[k] === 1 ? 1 : h[k] <= 0 ? Math.max(0, inl[k]) : -1;
  }
  for (let pass = 0; pass < 2; pass++) {
    const previous = mask.slice();
    for (let z = 1; z < N - 1; z++) {
      for (let x = 1; x < N - 1; x++) {
        const k = z * N + x;
        if (previous[k] >= 0) continue;
        let best = -1;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            best = Math.max(best, previous[k + dz * N + dx]);
          }
        }
        mask[k] = best;
      }
    }
  }
  for (let k = 0; k < mask.length; k++) mask[k] = Math.max(0, mask[k]);
  fields.set(world, mask);
  return mask;
}