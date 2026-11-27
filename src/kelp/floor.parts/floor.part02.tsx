    const d = new THREE.Vector3(random() - 0.5, random() * 0.9 - 0.25, random() - 0.5).normalize();
    const spine = new THREE.ConeGeometry(0.03, 0.6 + random() * 0.3, 3, 1);
    spine.translate(0, 0.42 + 0.3, 0);
    spine.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
    parts.push(spine);
  }
  const g = merge(parts.map((p) => p.toNonIndexed()));
  g.translate(0, 0.3, 0);
  return g;
}

// A sea star: five plump arms tapering from a raised middle.
function starShape() {
  const shape = new THREE.Shape();
  for (let i = 0; i <= 25; i++) {
    const a = (i / 25) * Math.PI * 2;
    const arm = Math.pow(Math.abs(Math.cos((a * 5) / 2)), 3);
    const r = 0.16 + 0.34 * arm;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.06, bevelSegments: 1, curveSegments: 2 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0.05, 0);
  return g;
}

// A tuft of weed: blades from one point, curving over.
function tuftShape(blades: number, salt: number, wide: number) {
  const random = lehmer(salt);
  const parts: THREE.BufferGeometry[] = [];
  for (let b = 0; b < blades; b++) {
    const a = random() * Math.PI * 2;
    const tall = 0.5 + random() * 0.5;
    const lean = 0.15 + random() * 0.35;
    const pts: number[] = [];
    const idx: number[] = [];
    const segs = 3;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const w = wide * (1 - u * 0.8);
      const x = Math.cos(a) * lean * u * u;
      const z = Math.sin(a) * lean * u * u;
      pts.push(x - Math.sin(a) * w, tall * u, z + Math.cos(a) * w, x + Math.sin(a) * w, tall * u, z - Math.cos(a) * w);
      if (i < segs) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g.toNonIndexed());
  }
  return merge(parts);
}

// An anemone: a short column and a crown of tentacles, swaying.
function anemoneShape() {
  const random = lehmer(707);
  const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.22, 0.28, 0.35, 8, 1).translate(0, 0.17, 0).toNonIndexed()];
  for (let i = 0; i < 14; i++) {
    const a = random() * Math.PI * 2;
    const r = 0.06 + random() * 0.17;
    const out = new THREE.Vector3(Math.cos(a), 1.6 + random(), Math.sin(a)).normalize();
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(Math.cos(a) * r, 0.34, Math.sin(a) * r), new THREE.Vector3(Math.cos(a) * r, 0.34, Math.sin(a) * r).addScaledVector(out, 0.3), new THREE.Vector3(Math.cos(a) * (r + 0.25), 0.75 + random() * 0.2, Math.sin(a) * (r + 0.25)));
    parts.push(new THREE.TubeGeometry(curve, 3, 0.022, 3, false).toNonIndexed());
  }
  return merge(parts);
}

export function Growth({ stones, plants, fine }: { stones: Stone[]; plants: Plant[]; fine: number }) {
  const meshes = useMemo(() => {
    const n = (count: number) => Math.max(4, Math.round(count * fine));
    const surf = spots(15, n(120), stones, plants, 14, [0.65, 1.25], 0.15);
    const turf = spots(17, n(110), stones, plants, 12, [0.16, 0.34], 0.4);
    return [
      grower(urchinShape(), spots(11, n(24), stones, plants, 9, [0.08, 0.13], 0.8), ["#3b1a4a", "#5b1f5c", "#24162e"], { bend: 0, height: 1, rough: 0.5 }),
      grower(starShape(), spots(12, n(14), stones, plants, 10, [0.15, 0.25], 0.6), ["#d45a1c", "#7a2a6a", "#c8402a", "#e09a3a"], { bend: 0, height: 1, rough: 0.8 }),
      grower(tuftShape(6, 41, 0.045), spots(13, n(140), stones, plants, 13, [0.28, 0.6], 0.5), ["#7a2a24", "#a2462a", "#5a6a26", "#3f5a22"], { bend: 0.5, height: 1 }),
      // Surfgrass: long bright ribbons scattered over the sand, and gathered into meadows, streaming with the water.
      grower(tuftShape(6, 47, 0.018), surf, ["#3a6a2a", "#4a742e", "#567e34"], { bend: 0.9, height: 1 }),
      grower(tuftShape(7, 53, 0.024), meadows(16, n(200), n(14), plants, [0.5, 1.05]), ["#36602a", "#44702c", "#527a34", "#5e823c"], { bend: 0.9, height: 1 }),
      // Tiny grass in front of the eye's start.
      grower(tuftShape(5, 67, 0.013), spots(18, n(180), stones, plants, 3.2, [0.07, 0.16], 0.1, [1.1, 5.4]), ["#4e6a2a", "#5a7430", "#6a7a34", "#3e5a24"], { bend: 0.7, height: 1 }),
      // Grass and weed around holdfasts.
      grower(tuftShape(5, 73, 0.014), aroundHoldfasts(plants.slice(0, 4), 10), ["#4e6a2a", "#5a7430", "#6a6a2c", "#7a3a24"], { bend: 0.6, height: 1 }),
      // Short fine turf among the stones.
      grower(tuftShape(5, 59, 0.02), turf, ["#4a6426", "#5e6e2c", "#3e5a26"], { bend: 0.6, height: 1 }),
      grower(anemoneShape(), spots(14, n(14), stones, plants, 8, [0.15, 0.25], 0.85), ["#4fa86a", "#d06a8a", "#e8c070"], { bend: 0.3, height: 0.9, tone: (base, local) => mix(base.mul(0.6), base.mul(1.3), smoothstep(0.3, 0.9, local.y)) })
    ];
  }, [stones, plants, fine]);
  useDispose(...meshes.flatMap((m) => [m.geometry, m.material as THREE.Material]));
  return (
    <>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </>
  );
}

