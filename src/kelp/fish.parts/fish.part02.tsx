          const side = level.mul(cos(roll)).add(flat.mul(sin(roll))) as any;
          const up = side.cross(f) as any;
          const turned = f.mul(local.x).add(up.mul(local.y)).add(side.mul(local.z)) as any;
          const nl = vec3(n.x, n.y.div(kind.deep), n.z) as any;
          return { position: A.xyz.add(turned.mul(A.w)), normal: normalize(f.mul(nl.x).add(up.mul(nl.y)).add(side.mul(nl.z))) };
        };
        const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.35 + (1 - kind.shine) * 0.4, metalness: 0, side: THREE.DoubleSide });
        const swum = posed(positionGeometry, attribute("normal", "vec3"));
        material.positionNode = swum.position;
        const normal = varying(swum.normal) as any;
        material.normalNode = transformNormalToView(normal) as any;
        const local = varying(positionGeometry) as any;
        const finned = varying(fin) as any;
        // An eye, dark with a pale ring, and the curve of the gill cover behind it, darker; a shark's slits instead.
        const eyeAt = shark ? vec3(0.42, 0.014, 0) : vec3(0.405, 0.024, 0);
        const eyeSize = shark ? 0.008 : 0.015;
        const fromEye = local.xy.sub(eyeAt.xy).length() as any;
        const side = smoothstep(0.004, 0.012, abs(local.z)).mul(finned.oneMinus()) as any;
        const pupil = smoothstep(eyeSize * 0.62, eyeSize * 0.5, fromEye).mul(side) as any;
        const ring = smoothstep(eyeSize, eyeSize * 0.85, fromEye).mul(side).sub(pupil).max(0) as any;
        const gill = shark
          ? smoothstep(0.003, 0.0015, abs(local.x.sub(0.3).mod(0.016).sub(0.008))).mul(smoothstep(0.34, 0.33, local.x)).mul(smoothstep(0.25, 0.26, local.x)).mul(smoothstep(0.03, 0.02, abs(local.y)))
          : smoothstep(0.004, 0.0015, abs(local.x.sub(float(0.335).sub(local.y.mul(local.y).mul(6))))).mul(smoothstep(0.075, 0.05, abs(local.y)));
        // Scales on a bony fish: rows of them, each row set half a scale over, each scale's rounded edge lying back
        // toward the tail, a little darker, and its face catching the light. Only drawn where a fish is big enough on
        // screen for them to show, so far ones never shimmer.
        const scaled = shark
          ? float(1)
          : (() => {
              const sy = local.y.mul(52) as any;
              const row = sy.floor() as any;
              const sx = local.x.mul(44).add(row.mod(2).mul(0.5)) as any;
              const cell = vec3(sx.fract(), sy.fract(), 0) as any;
              const d = cell.xy.sub(vec3(1, 0.5, 0).xy).mul(vec3(1, 1.15, 0).xy).length() as any;
              const edge = smoothstep(0.78, 0.92, d).mul(smoothstep(1.05, 0.95, d)) as any;
              const face = smoothstep(0.95, 0.2, d).mul(0.08) as any;
              const close = smoothstep(9, 3, positionWorld.sub(cameraPosition).length().div(A.w)).mul(finned.oneMinus()).mul(smoothstep(0.42, 0.36, local.x)) as any;
              return float(1).add(face.sub(edge.mul(0.22)).mul(close));
            })();
        const skin = kind.tone(local.x, local.y, local.z, H.w.fract()).mul(scaled) as any;
        // Fins paler and a little see-through at their edges.
        const body = mix(skin, skin.mul(0.8).add(0.04), finned.mul(0.6)) as any;
        const tone = mix(mix(body.mul((gill as any).mul(-0.35).add(1)), color("#d8d0b0").mul(skin.add(0.3)), ring.mul(0.6)), color("#050505"), pupil) as any;
        material.colorNode = tone;
        // Silver sides flash as a fish turns its flank to the light.
        const V = normalize(cameraPosition.sub(positionWorld)) as any;
        const flash = pow(max(normal.dot(normalize(V.add(sea.toSun))), 0), 12).mul(kind.shine).mul(sea.power).mul(0.4) as any;
        underSea(material, tone, { normal, caustics: false, through: tone.mul(finned).mul(0.08), extra: sea.sun.mul(flash).add(haze(normal).mul(kind.shine * 0.25)) });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        return { shoal, mesh, at, facing, swim };
      }),
    [schools, shapes, seed]
  );
  useDispose(shapes.fish, shapes.shark, shapes.small, shapes.tiny, shapes.far, ...built.flatMap((b) => [b.mesh.geometry, b.mesh.material as THREE.Material]));

  useFrame((_, raw) => {
    if (!active) return;
    const delta = Math.min(raw, 1 / 20);
    const live = scenePhase.current === "live";
    for (const { shoal, at, facing, swim } of built) {
      if (live) shoal.seen += delta;
      shoal.step(delta, stirs);
      const f = shoal.fish;
      const a = at.array as Float32Array;
      const h = facing.array as Float32Array;
      const w = swim.array as Float32Array;
      for (let i = 0; i < f.count; i++) {
        w[i * 4] = f.beat[i];
        w[i * 4 + 1] = f.effort[i];
        w[i * 4 + 2] = f.curve[i];
        a[i * 4] = f.position[i * 3];
        a[i * 4 + 1] = f.position[i * 3 + 1];
        a[i * 4 + 2] = f.position[i * 3 + 2];
        a[i * 4 + 3] = f.size[i];
        h[i * 4] = f.heading[i * 3];
        h[i * 4 + 1] = f.heading[i * 3 + 1];
        h[i * 4 + 2] = f.heading[i * 3 + 2];
      }
      at.needsUpdate = true;
      facing.needsUpdate = true;
      swim.needsUpdate = true;
    }
  });

  return (
    <>
      {built.map((b, i) => (
        <primitive key={i} object={b.mesh} />
      ))}
    </>
  );
}

// Jellyfish drifting in the water column: a pulsing bell, glowing faintly at its rim, trailing fine tentacles.
export function Jellies({ count }: { count: number }) {
  const { mesh, material } = useMemo(() => {
    const random = lehmer(6061);
    const bell = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
    const strands: THREE.BufferGeometry[] = [bell];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const pts: number[] = [];
      const segs = 12;
      const r = 0.85;
      for (let s = 0; s < segs; s++) {
        const y0 = -(s / segs) * 3.2;
        const y1 = -((s + 1) / segs) * 3.2;
        const w = 0.03;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        pts.push(x - w, y0, z, x + w, y0, z, x + w, y1, z, x - w, y0, z, x + w, y1, z, x - w, y1, z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      g.computeVertexNormals();
      strands.push(g);
    }
    const shape = merge(strands);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", shape.getAttribute("position"));
    geometry.setAttribute("normal", shape.getAttribute("normal"));
    const at: number[] = [];
    for (let i = 0; i < count; i++) {
      const a = random() * Math.PI * 2;
      const r = 1.5 + random() * 10;
      at.push(Math.cos(a) * r, 2.5 + random() * 4.5, Math.sin(a) * r - 1, 0.07 + random() * 0.12);
    }
    geometry.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(at), 4));
    geometry.instanceCount = count;
    shape.dispose();
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const A = attribute("aAt", "vec4") as any;
    const p = positionGeometry as any;
    const t = sea.clock as any;
    const seed = A.x.mul(13.1).add(A.z.mul(7.7)) as any;
    const pulse = sin(t.mul(1.6).add(seed)) as any;
    const isBell = p.y.greaterThan(-0.01).select(1, 0) as any;
    // The bell squeezes and opens; the tentacles trail and wave below.
    const squeeze = float(1).sub(pulse.mul(0.12).mul(isBell)) as any;
    const trail = p.y.negate().max(0) as any;
    const wave = (vec3 as any)((sin as any)(t.mul(0.9).add(seed).add(trail.mul(1.6))).mul(trail).mul(0.12), 0, (cos as any)(t.mul(0.7).add(seed).add(trail.mul(1.3))).mul(trail).mul(0.12)) as any;
    const local = vec3(p.x.mul(squeeze), p.y.mul(isBell.mul(pulse.mul(0.15).add(0.85)).add(isBell.oneMinus())), p.z.mul(squeeze)).add(wave) as any;
    const drift = vec3(sin(t.mul(0.05).add(seed)).mul(1.5), sin(t.mul(0.08).add(seed.mul(1.3))).mul(0.8), cos(t.mul(0.04).add(seed)).mul(1.5)) as any;
    const centre = A.xyz.add(drift) as any;
    material.positionNode = centre.add(local.mul(A.w)) as any;
    const shell = varying(p) as any;
    material.colorNode = Fn(() => {
      const rim = smoothstep(0.3, 0.05, shell.y).mul(isBell) as any;
      const body = isBell.mul(0.25).add(rim.mul(0.9)).add(isBell.oneMinus().mul(0.35)) as any;
      const tint = mix(color("#ff9ad8"), color("#8ad8ff"), (mx_noise_float(centre.mul(0.3)) as any).mul(0.5).add(0.5)) as any;
      const d = positionWorld.sub(cameraPosition).length() as any;
      const lit = sea.shallow.mul(0.4).add(sea.sun.mul(sea.power).mul(0.1)).add(tint.mul(sea.glow.mul(0.6).add(0.1))).add(tint.mul(stirred(centre).mul(4))) as any;
      return vec4(lit.mul(body).mul(through(d)).mul(0.6), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return { mesh, material };
  }, [count]);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}

