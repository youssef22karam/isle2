
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Fn, abs, attribute, cameraPosition, color, cos, float, max, mix, mx_noise_float, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, transformNormalToView, varying, vec3, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";
import { useDispose } from "./engine/dispose";
import { scenePhase } from "./engine/quality";
import { BANDS, bandOf, kelpColumns } from "./avoid";
import { lehmer } from "./engine/random";
import { floorAt } from "./kelp";
import { stirs, type Stir } from "./stir";
import { underSea } from "./shade";
import type { School } from "./versions";
import { SURFACE, haze, sea, stirred, through } from "./water";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Merged from position and normal only, whatever else each part carries.
function merge(parts: THREE.BufferGeometry[]) {
  const bare = parts.map((p) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", p.getAttribute("position"));
    if (!p.getAttribute("normal")) p.computeVertexNormals();
    g.setAttribute("normal", p.getAttribute("normal"));
    if (p.getIndex()) g.setIndex(p.getIndex());
    return g.getIndex() ? g.toNonIndexed() : g;
  });
  return mergeGeometries(bare);
}

// Fish: two shapes, built here, a bony fish and a shark, each bent side to side as it swims, its fins working,
// stretched deep or slender and painted by its kind, with eyes and gill covers. A school follows a leader along a slow loop, each fish
// keeping its own place round it; solitary fish keep to their own patch. All of them dart from the pointer.

type Kind = {
  size: [number, number];
  deep: number;
  speed: number;
  // How far round the leader a school spreads, and whether each fish keeps to its own patch instead.
  spread: number;
  solo: boolean;
  height: [number, number];
  tone: (x: any, y: any, z: any, hue: any) => any;
  shine: number;
  // How much wider than usual a school's loop runs, and how far from the middle solitary fish keep their patches: the
  // big fish keep their distance, out in the haze.
  orbit?: number;
  reach?: number;
  // Where a school's loop, or a solitary fish's patch, is centred, if not the middle: every big fish keeps far out ahead of
  // the eye's start, the way the forest is mostly looked at, seen only as a shape in the haze; only small fish come near.
  centre?: [number, number];
  shape?: "fish" | "shark";
};

const silverSides = (x: any, y: any, back: string, belly: string) => mix(color(belly), color(back), smoothstep(-0.01, 0.045, y)) as any;

const KINDS: Record<School["kind"], Kind> = {
  sardine: {
    size: [0.13, 0.18],
    deep: 0.8,
    speed: 1.3,
    spread: 1.3,
    solo: false,
    height: [2.5, 6],
    shine: 1,
    tone: (x, y) => silverSides(x, y, "#1d4a5a", "#d8e2e6").mul(smoothstep(0.004, 0.0, abs(y.sub(0.012))).mul(sin(x.mul(80)).mul(0.5).add(0.5)).mul(-0.5).add(1))
  },
  garibaldi: { size: [0.26, 0.34], deep: 1.7, speed: 0.4, spread: 0, solo: true, height: [0.4, 1.6], shine: 0.2, tone: () => color("#ff6a10").mul(1.1) },
  bass: { size: [0.4, 0.55], deep: 1.15, speed: 0.5, spread: 0, solo: true, reach: 5, centre: [-1, -15], height: [1, 4], shine: 0.3, tone: (x, y, z) => silverSides(x, y, "#3c4428", "#a8a68a").mul(smoothstep(0.1, 0.4, mx_noise_float(vec3(x.mul(14), y.mul(30), z))).mul(0.35).add(0.75)) },
  chromis: { size: [0.08, 0.11], deep: 1.4, speed: 1, spread: 1.1, solo: false, height: [1.5, 4], shine: 0.6, tone: (x, y) => mix(color("#3aa0e8"), color("#6ad8c8"), smoothstep(0.03, -0.03, y)) },
  tang: { size: [0.17, 0.22], deep: 2.2, speed: 0.6, spread: 2.5, solo: false, height: [0.8, 2.5], shine: 0.3, tone: () => color("#ffd800") },
  clown: {
    size: [0.08, 0.1],
    deep: 1.4,
    speed: 0.35,
    spread: 0,
    solo: true,
    height: [0.3, 0.8],
    shine: 0.3,
    tone: (x) => {
      const band = (c: number) => smoothstep(0.03, 0.02, abs(x.sub(c))) as any;
      const white = max(max(band(0.22), band(-0.02)), band(-0.3)) as any;
      const edge = max(max(smoothstep(0.045, 0.03, abs(x.sub(0.22))), smoothstep(0.045, 0.03, abs(x.sub(-0.02)))), smoothstep(0.045, 0.03, abs(x.sub(-0.3)))).sub(white) as any;
      return mix(mix(color("#ff7010"), color("#101010"), edge), color("#ffffff"), white);
    }
  },
  parrot: { size: [0.45, 0.6], deep: 1.4, speed: 0.45, spread: 0, solo: true, height: [0.6, 2], shine: 0.3, tone: (x, y, z, hue) => mix(color("#1ab5a0"), color("#e86aa0"), smoothstep(0.2, 0.6, mx_noise_float(vec3(x.mul(12), y.mul(20), hue.mul(10))))) },
  cod: { size: [0.16, 0.24], deep: 0.85, speed: 0.8, spread: 1.6, solo: false, height: [1, 4], shine: 0.5, tone: (x, y) => silverSides(x, y, "#5a5a48", "#c8ccc4").mul(smoothstep(0.2, 0.5, mx_noise_float(vec3(x.mul(30), y.mul(40), 1))).mul(0.2).add(0.9)) },
  jack: { size: [0.14, 0.2], deep: 1.25, speed: 1.1, spread: 1.4, solo: false, height: [5, 7.6], shine: 1, tone: (x, y) => mix(silverSides(x, y, "#2a5a8a", "#e0eaf0"), color("#ffd040"), smoothstep(-0.32, -0.42, x)) },
  mahi: { size: [0.9, 1.2], deep: 1.3, speed: 0.9, spread: 0, solo: true, height: [4, 7], shine: 0.7, tone: (x, y, z) => mix(mix(color("#f0d020"), color("#2a9a6a"), smoothstep(-0.02, 0.06, y)), color("#3a8ad0"), smoothstep(0.4, 0.7, mx_noise_float(vec3(x.mul(18), y.mul(25), z.mul(5)))).mul(0.5)) },
  seabass: {
    size: [1.4, 1.9],
    deep: 1.25,
    speed: 0.35,
    spread: 0,
    solo: true,
    height: [0.9, 3],
    reach: 7,
    centre: [2, -21],
    shine: 0.2,
    tone: (x, y, z) => mix(color("#3a3a34"), color("#5a564a"), smoothstep(0.02, -0.06, y)).mul(smoothstep(0.55, 0.7, mx_noise_float(vec3(x.mul(16), y.mul(16), z.mul(4)))).mul(-0.45).add(1))
  },
  shark: {
    shape: "shark",
    size: [2, 2.7],
    deep: 1,
    speed: 0.6,
    spread: 5,
    solo: false,
    orbit: 1.1,
    centre: [4, -24],
    height: [1.5, 5],
    shine: 0.15,
    tone: (x, y, z) => mix(color("#d8d4c8"), color("#6a6458"), smoothstep(-0.04, 0.02, y)).mul(smoothstep(0.6, 0.75, mx_noise_float(vec3(x.mul(30), y.mul(30), z.mul(6)))).mul(-0.4).add(1))
  },
  // Far out in the haze, seen only as shapes: a few big sharks on a wide loop, and a great school of jacks.
  farshark: {
    shape: "shark",
    size: [2.6, 3.4],
    deep: 1,
    speed: 0.5,
    spread: 7,
    solo: false,
    orbit: 1.4,
    centre: [8, -31],
    height: [2, 6],
    shine: 0,
    tone: () => color("#3a3c3a")
  },
  farjack: { size: [0.3, 0.42], deep: 1.2, speed: 0.9, spread: 2.5, solo: false, orbit: 1.2, centre: [0, -24], height: [3.5, 7], shine: 0.6, tone: (x, y) => silverSides(x, y, "#2a4a60", "#b8c4c8") },
  yellowtail: { size: [0.55, 0.75], deep: 0.9, speed: 0.9, spread: 3, solo: false, orbit: 1, centre: [-3, -19], height: [3, 6], shine: 0.8, tone: (x, y) => mix(silverSides(x, y, "#3a5a70", "#e0e6ea"), color("#ffd040"), max(smoothstep(-0.32, -0.42, x), smoothstep(0.006, 0, abs(y.sub(0.005))))) }
};

// One unit long, head at +x, built from rings round a body that is deepest a third back from the head, narrowing to a
// slim wrist before the tail. Each vertex carries 0 on the body and 1 on a fin, for the fins to be paler and let light
// through. Fins: a forked tail, a long fin down the back, one under the tail, and a pair at the gills and the belly.
function fishShape(along = 30, round = 16) {
  const body = (u: number) => {
    // Height round the body from the snout back: rounded at the head, deepest at a third, a slim wrist at the tail.
    const head = Math.pow(Math.sin(Math.PI * 0.5 * Math.min(1, u / 0.32)), 0.75);
    const back = 1 - Math.pow(Math.max(0, (u - 0.32) / 0.68), 1.25) * 0.86;
    return 0.12 * head * back + 0.004;
  };
  const profile = (x: number) => body(Math.min(1, Math.max(0, (0.5 - x) / 0.86)));
  const pts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= along; i++) {
    const u = i / along;
    const x = 0.5 - u * 0.86;
    const h = body(u);
    const w = h * (0.46 - u * 0.12);
    for (let j = 0; j <= round; j++) {
      const a = (j / round) * Math.PI * 2;
      // A little fuller below than above, as a belly.
      const y = Math.cos(a) * h * (Math.cos(a) < 0 ? 0.92 : 1);
      pts.push(x, y, Math.sin(a) * w);
    }
  }
  for (let i = 0; i < along; i++)
    for (let j = 0; j < round; j++) {
      const a = i * (round + 1) + j;
      const b = a + round + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const trunk = new THREE.BufferGeometry();
  trunk.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  trunk.setIndex(idx);
  trunk.computeVertexNormals();
  return withFins(trunk, [
    // A forked tail.
    fan([-0.34, 0, 0], [[-0.43, 0.02], [-0.55, 0.15], [-0.5, 0.12], [-0.45, 0.03], [-0.44, 0], [-0.45, -0.03], [-0.5, -0.12], [-0.55, -0.15], [-0.43, -0.02]]),
    // A long fin down the back, spiny and taller in front, and one under the tail, both grown from the body's outline.
    median((x) => profile(x), 0.19, -0.25, (t) => 0.07 * Math.min(1, t / 0.1) * (1 - 0.35 * t) * Math.min(1, (1 - t) / 0.18), 0.02),
    median((x) => -profile(x) * 0.92, -0.05, -0.25, (t) => -0.055 * Math.min(1, t / 0.25) * Math.min(1, (1 - t) / 0.4), 0.03),
    // A pair at the gills, splayed out, and a pair at the belly.
    side([0.3, -0.03], [[0.3, -0.03], [0.2, -0.05], [0.16, -0.09], [0.22, -0.08]], 0.035, 0.6),
    side([0.15, -0.085], [[0.15, -0.085], [0.06, -0.12], [0.1, -0.1]], 0.025, 0.4)
  ]);
}

// A shark, one unit long, head at +x: a long body with a pointed snout, a tall fin on the back and a small one behind
// it, broad fins swept back from the gills, and a tail with a long upper lobe.
function sharkShape(along = 34, round = 16) {
  const height = (u: number) => {
    const nose = Math.pow(Math.min(1, u / 0.3), 0.6);
    const tail = 1 - Math.pow(Math.max(0, (u - 0.3) / 0.7), 1.2) * 0.9;
    return { nose, h: 0.075 * nose * tail + 0.003 };
  };
  const top = (x: number) => height(Math.min(1, Math.max(0, (0.5 - x) / 0.84))).h;
  const pts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= along; i++) {
    const u = i / along;
    const x = 0.5 - u * 0.84;
    const { nose, h } = height(u);
    const w = h * 0.85;
    for (let j = 0; j <= round; j++) {
      const a = (j / round) * Math.PI * 2;
      // Flat underneath, the snout sloping down to it.
      const c = Math.cos(a);
      const y = c > 0 ? c * h : c * h * 0.7;
      pts.push(x, y - (1 - nose) * 0.01, Math.sin(a) * w);
    }
  }
  for (let i = 0; i < along; i++)
    for (let j = 0; j < round; j++) {
      const a = i * (round + 1) + j;
      const b = a + round + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const trunk = new THREE.BufferGeometry();
  trunk.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  trunk.setIndex(idx);
  trunk.computeVertexNormals();
  return withFins(trunk, [
    fan([-0.32, 0.005, 0], [[-0.36, 0.02], [-0.47, 0.13], [-0.5, 0.15], [-0.47, 0.09], [-0.42, 0.01], [-0.4, -0.02], [-0.44, -0.07], [-0.38, -0.04]]),
    // The tall fin on the back, swept back, a small second one behind it, and one underneath, grown from the body.
    median(top, 0.13, -0.05, (t) => 0.13 * Math.min(t / 0.55, (1 - t) / 0.45) ** 0.8, 0.5),
    median(top, -0.17, -0.235, (t) => 0.035 * Math.min(t / 0.5, (1 - t) / 0.5), 0.4),
    median((x) => -top(x) * 0.7, -0.14, -0.215, (t) => -0.03 * Math.min(t / 0.5, (1 - t) / 0.5), 0.4),
    side([0.2, -0.04], [[0.21, -0.04], [0.06, -0.09], [0.03, -0.12], [0.12, -0.05]], 0.06, 0.25)
  ]);
}

// A flat fin in the body's middle plane, fanned from a root point out round its edge.
function fan(root: number[], edge: number[][]) {
  const pts: number[] = [];
  for (let i = 0; i < edge.length - 1; i++) pts.push(root[0], root[1], 0, edge[i][0], edge[i][1], 0, edge[i + 1][0], edge[i + 1][1], 0);
  return pts;
}

// A fin in the body's middle plane along its back or belly, from x0 to x1: its base follows the body's outline (from
// edge, a little inside it so no gap shows), and it stands tall(t) out from it, t running 0 to 1 along the base, its
// tips swept back by sweep times their height.
function median(edge: (x: number) => number, x0: number, x1: number, tall: (t: number) => number, sweep: number) {
  const pts: number[] = [];
  const steps = 8;
  const at = (k: number) => {
    const t = k / steps;
    const x = x0 + (x1 - x0) * t;
    const base = edge(x) * 0.85;
    const h = tall(t);
    return { x, base, tipX: x - Math.abs(h) * sweep, tip: edge(x) + h };
  };
  for (let k = 0; k < steps; k++) {
    const a = at(k);
    const b = at(k + 1);
    pts.push(a.x, a.base, 0, b.x, b.base, 0, b.tipX, b.tip, 0, a.x, a.base, 0, b.tipX, b.tip, 0, a.tipX, a.tip, 0);
  }
  return pts;
}

// A pair of fins on the flanks: the outline given in x and y, splayed out by spread at its tip and tipped down by droop.
function side(root: number[], outline: number[][], spread: number, droop: number) {
  const pts: number[] = [];
  for (const s of [-1, 1]) {
    const at = (p: number[]) => {
      const far = Math.hypot(p[0] - root[0], p[1] - root[1]) / 0.1;
      return [p[0], p[1] - far * droop * 0.02, s * (0.025 + far * spread)];
    };
    for (let i = 1; i < outline.length - 1; i++) pts.push(...at(outline[0]), ...at(outline[i]), ...at(outline[i + 1]));
  }
  return pts;
}

// Kept indexed, so each point of the body is posed once however many triangles share it.
function withFins(trunk: THREE.BufferGeometry, fins: number[][]) {
  const body = new THREE.BufferGeometry();
  body.setAttribute("position", trunk.getAttribute("position"));
  body.setAttribute("normal", trunk.getAttribute("normal"));
  body.setAttribute("aFin", new THREE.Float32BufferAttribute(new Float32Array(trunk.getAttribute("position").count), 1));
  body.setIndex(trunk.getIndex());
  const parts = [body];
  for (const f of fins) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(f, 3));
    g.computeVertexNormals();
    g.setAttribute("aFin", new THREE.Float32BufferAttribute(new Float32Array(f.length / 3).fill(1), 1));
    g.setIndex(Array.from({ length: f.length / 3 }, (_, i) => i));
    parts.push(g);
  }
  return mergeGeometries(parts);
}

// beat is the phase of each fish's tail stroke, effort how hard it is swimming (0 hanging still, 1 flat out), and curve
// how much its body curls into a turn.
// Seconds each school swims before it is first shown, to settle into its shape.
const WARM = 4;
const ease = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const visitPass = new THREE.Vector3();
// Where a visiting school swirls: a couple of metres in front of the eye's start and a little above it.
const VISIT = [1.9, 1.8, 5.0];
const scratchLoop = new THREE.Vector3();

type Fish = { kind: Kind; count: number; position: Float32Array; velocity: Float32Array; heading: Float32Array; slot: Float32Array; home: Float32Array; size: Float32Array; beat: Float32Array; effort: Float32Array; curve: Float32Array };

class Shoal {
  fish: Fish;
  time = 0;
  phase: number;
  // Whether this school comes by the eye's start, and how long the forest has been on screen.
  visit: boolean;
  seen = 0;
  private random: () => number;
  constructor(school: School, seed: number, visit = false) {
    this.visit = visit;
    const kind = KINDS[school.kind];
    const random = (this.random = lehmer(seed));
    const n = school.count;
    const fish: Fish = { kind, count: n, position: new Float32Array(n * 3), velocity: new Float32Array(n * 3), heading: new Float32Array(n * 3), slot: new Float32Array(n * 3), home: new Float32Array(n * 3), size: new Float32Array(n), beat: new Float32Array(n), effort: new Float32Array(n), curve: new Float32Array(n) };
    this.phase = random() * 10;
    for (let i = 0; i < n; i++) {
      // A place in the school: in a squashed ball, thicker in the middle.
      const d = new THREE.Vector3(random() - 0.5, (random() - 0.5) * 0.6, random() - 0.5).normalize().multiplyScalar(Math.cbrt(random()) * kind.spread);
      fish.slot.set([d.x, d.y, d.z], i * 3);
      const a = random() * Math.PI * 2;
      const r = kind.reach ? kind.reach * (0.6 + random() * 0.4) : 2 + random() * 9;
      const hx = Math.cos(a) * r + (kind.centre?.[0] ?? 0);
      const hz = Math.sin(a) * r - 1 + (kind.centre?.[1] ?? 0);
      const hy = floorAt(hx, hz) + kind.height[0] + random() * (kind.height[1] - kind.height[0]);
      fish.home.set([hx, hy, hz], i * 3);
      fish.position.set([hx, hy, hz], i * 3);
      fish.heading.set([1, 0, 0], i * 3);
      fish.size[i] = kind.size[0] + random() * (kind.size[1] - kind.size[0]);
      fish.beat[i] = random() * Math.PI * 2;
    }
    this.fish = fish;
    for (let k = 0; k < WARM * 30; k++) this.step(1 / 30, []);
  }

  // Where the leader is: a slow loop through the forest, rising and falling.
  leader(t: number, out: THREE.Vector3) {
    const o = this.fish.kind.orbit ?? 1;
    const s = (0.05 * this.fish.kind.speed) / o;
    const a = t * s + this.phase;
    if (this.visit) {
      // A visit: four seconds after the forest is on screen, and again every minute and a quarter, the school leaves its
      // loop, comes right up in front of the eye's start and swirls there, a couple of metres off, then goes back.
      // Timed from when the forest is shown, not from its first frame, which may come long before behind the loader.
      const since = (((this.seen + t - this.time - 4) % 75) + 75) % 75;
      const w = ease(0, 4, since) * (1 - ease(19, 25, since));
      if (w > 0) {
        const turn = since * 0.38;
        const pass = visitPass.set(VISIT[0] + Math.cos(turn) * 1.1, VISIT[1] + Math.sin(turn * 1.3) * 0.3, VISIT[2] + Math.sin(turn) * 0.7);
        const loop = this.loop(a, o, scratchLoop);
        return out.copy(loop).lerp(pass, w);
      }
    }
    return this.loop(a, o, out);
  }

  private loop(a: number, o: number, out: THREE.Vector3) {
    const [cx, cz] = this.fish.kind.centre ?? [0, 0];
    return out.set((Math.cos(a) * 6 + Math.sin(a * 2.3) * 1.5) * o + cx, (this.fish.kind.height[0] + this.fish.kind.height[1]) / 2 + Math.sin(a * 1.7) * 1.2, (Math.sin(a) * 4.5 + Math.cos(a * 1.3) * 1.5) * o - 1 + cz);
  }

  step(delta: number, stirs: Stir[]) {
    if (!(delta > 1e-5)) return;
    this.time += delta;
    const f = this.fish;
    const k = f.kind;
    const lead = this.leader(this.time, new THREE.Vector3());
    const ahead = this.leader(this.time + 0.5, new THREE.Vector3()).sub(lead);
    // How the leader is going, for each fish to match.
    const lvx = ahead.x / 0.5;
    const lvy = ahead.y / 0.5;
    const lvz = ahead.z / 0.5;
    const turn = Math.atan2(ahead.z, ahead.x);
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const toP = new THREE.Vector3();
    for (let i = 0; i < f.count; i++) {
      const o = i * 3;
      let tx: number;
      let ty: number;
      let tz: number;
      // The speed it would like to be going: the school's, or along its own wandering path.
      let wx = lvx;
      let wy = lvy;
      let wz = lvz;
      if (k.solo) {
        // Its own patch, wandered slowly round.
        const rate = 0.15 * k.speed;
        const w = this.time * rate + i * 7.1;
        tx = f.home[o] + Math.sin(w) * 1.2;
        ty = f.home[o + 1] + Math.sin(w * 0.7) * 0.3;
        tz = f.home[o + 2] + Math.cos(w * 1.3) * 1.2;
        wx = Math.cos(w) * 1.2 * rate;
        wy = Math.cos(w * 0.7) * 0.21 * rate;
        wz = -Math.sin(w * 1.3) * 1.56 * rate;
      } else {
        const sx = f.slot[o];
        const sz = f.slot[o + 2];
        const w = this.time * 0.6 + i;
        tx = lead.x + sx * c - sz * s + Math.sin(w) * 0.15;
        ty = lead.y + f.slot[o + 1] + Math.sin(w * 1.3) * 0.1;
        tz = lead.z + sx * s + sz * c + Math.cos(w * 0.9) * 0.15;
      }
      const px = f.position[o];
      const py = f.position[o + 1];
      const pz = f.position[o + 2];
      // Steered to match that speed while easing toward its place: well damped, so a fish swims steadily along with its
      // school instead of springing at a point and swinging its head about round it.
      let ax = (tx - px) * 0.9 + (wx - f.velocity[o]) * 1.6;
      let ay = (ty - py) * 0.9 + (wy - f.velocity[o + 1]) * 1.8;
      let az = (tz - pz) * 0.9 + (wz - f.velocity[o + 2]) * 1.6;
      // Away from the pointer's line through the water, and from bursts.
      for (const st of stirs) {
        const fade = Math.exp(-st.age * 2);
        if (st.burst > 0) {
          toP.set(px - st.at.x, py - st.at.y, pz - st.at.z);
        } else {
          toP.set(px - st.origin.x, py - st.origin.y, pz - st.origin.z);
          const along = toP.dot(st.dir);
          if (along <= 0) continue;
          toP.addScaledVector(st.dir, -along);
        }
        const d = toP.length() + 1e-3;
        const reach = st.burst > 0 ? 2.2 : 1.1;
        if (d < reach) {
          const push = (14 * fade * (1 - d / reach)) / d;
          ax += toP.x * push;
          ay += toP.y * push * 0.5;
          az += toP.z * push;
        }
      }
      // Round the kelp, not through it: near a plant's stipes at this height, pushed out from their middle, harder the
      // closer, and whatever of its speed heads inward taken away, so it slides round the outside.
      if (kelpColumns.plants) {
        const band = bandOf(py);
        const cols = kelpColumns.data;
        for (let pl = 0; pl < kelpColumns.plants; pl++) {
          const at = (pl * BANDS + band) * 4;
          const spread = cols[at + 2];
          if (spread < 0) continue;
          const dx = px - cols[at];
          const dz = pz - cols[at + 1];
          const reach = spread + 0.3 + f.size[i];
          const d2 = dx * dx + dz * dz;
          if (d2 > reach * reach) continue;
          const d = Math.sqrt(d2) + 1e-4;
          const push = (10 * (1 - d / reach)) / d;
          ax += dx * push;
          az += dz * push;
          const inward = (f.velocity[o] * dx + f.velocity[o + 2] * dz) / d;
          if (inward < 0) {
            ax -= (dx / d) * inward * 4;
            az -= (dz / d) * inward * 4;
          }
        }
      }
      let vx = f.velocity[o] + ax * delta;
      let vy = f.velocity[o + 1] + ay * delta;
      let vz = f.velocity[o + 2] + az * delta;
      const speed = Math.hypot(vx, vy, vz);
      const most = k.speed * 3.5;
      if (speed > most) {
        vx *= most / speed;
        vy *= most / speed;
        vz *= most / speed;
      }
      f.velocity[o] = vx;
      f.velocity[o + 1] = vy;
      f.velocity[o + 2] = vz;
      let nx = px + vx * delta;
      let ny = py + vy * delta;
      let nz = pz + vz * delta;
      ny = Math.min(SURFACE - 0.4, Math.max(floorAt(nx, nz) + 0.25, ny));
      f.position[o] = nx;
      f.position[o + 1] = ny;
      f.position[o + 2] = nz;
      // The tail beats as fast as the fish is going: a body length and a half a stroke, never quite still, so a fish
      // hanging in the water only fans gently and one dashing off thrashes. Effort eases, so strokes never jerk.
      const size = f.size[i];
      const lengths = speed / size;
      const want = Math.min(1, 0.15 + lengths / 2.5);
      f.effort[i] += (want - f.effort[i]) * (1 - Math.exp(-delta * 3));
      f.beat[i] = (f.beat[i] + delta * Math.PI * 2 * Math.min(8, 0.6 + lengths * 0.9)) % (Math.PI * 200);
      const was0 = f.heading[o];
      const was2 = f.heading[o + 2];
      // Turn toward where it is going, gently, and stay level.
      if (speed > 0.02) {
        const h = 1 - Math.exp(-delta * 5);
        let hx = f.heading[o] + (vx / speed - f.heading[o]) * h;
        let hy = f.heading[o + 1] + ((vy / speed) * 0.5 - f.heading[o + 1]) * h;
        let hz = f.heading[o + 2] + (vz / speed - f.heading[o + 2]) * h;
        const l = Math.hypot(hx, hy, hz) || 1;
        hx /= l;
        hy /= l;
        hz /= l;
        f.heading[o] = hx;
        f.heading[o + 1] = hy;
        f.heading[o + 2] = hz;
      }
      // Curled into the turn by how fast it is turning.
      const yaw = (was2 * f.heading[o] - was0 * f.heading[o + 2]) / delta;
      const curl = Math.max(-0.5, Math.min(0.5, yaw * 0.12));
      f.curve[i] += (curl - f.curve[i]) * (1 - Math.exp(-delta * 6));
    }
  }
}

export function Fishes({ schools, active, seed }: { schools: School[]; active: boolean; seed: number }) {
  // Full detail for the big fish; the small and the far, a few pixels long, are drawn with fewer rings.
  const shapes = useMemo(() => ({ fish: fishShape(12, 8), shark: sharkShape(14, 8), small: fishShape(8, 6), tiny: fishShape(6, 5), far: sharkShape(10, 6) }), []);
  const built = useMemo(
    () =>
      schools.map((school, n) => {
        // The first school of sardines comes by the eye's start.
        const shoal = new Shoal(school, seed * 31 + n * 977 + 5, n === schools.findIndex((s) => s.kind === "sardine"));
        const kind = shoal.fish.kind;
        const far = !!kind.centre;
        const small = kind.size[1] < 0.45 || far;
        // The far ones, a few pixels long, coarse; small fish near enough to come by the eye, finer.
        const shape = kind.shape === "shark" ? (far ? shapes.far : shapes.shark) : far ? shapes.tiny : small ? shapes.small : shapes.fish;
        const shark = kind.shape === "shark";
        const geometry = new THREE.InstancedBufferGeometry();
        for (const name of ["position", "normal", "aFin"]) geometry.setAttribute(name, shape.getAttribute(name));
        geometry.setIndex(shape.getIndex());
        // Rewritten whole every frame and sent once: left at the usual usage, as three's WebGPU backend sends an attribute
        // marked dynamic again for every pass it is drawn in, whether or not it has changed since.
        const at = new THREE.InstancedBufferAttribute(new Float32Array(school.count * 4), 4);
        const facing = new THREE.InstancedBufferAttribute(new Float32Array(school.count * 4), 4);
        const swim = new THREE.InstancedBufferAttribute(new Float32Array(school.count * 4), 4);
        geometry.setAttribute("aAt", at);
        geometry.setAttribute("aFacing", facing);
        geometry.setAttribute("aSwim", swim);
        geometry.instanceCount = school.count;
        for (let i = 0; i < school.count; i++) facing.array[i * 4 + 3] = Math.random() * 100;

        const A = attribute("aAt", "vec4") as any;
        const H = attribute("aFacing", "vec4") as any;
        // Swims by a wave running down the body to the tail, as hard and as fast as the fish is going (the beat's phase
        // and strength come from the processor), and curls into its turns.
        const fin = attribute("aFin", "float") as any;
        const S = attribute("aSwim", "vec4") as any;
        const posed = (p: any, n: any) => {
          // How far back along the body, 0 at the snout and 1 at the root of the tail, and on into the tail fin.
          const back = float(0.5).sub(p.x).div(0.86).clamp(0, 1.25) as any;
          // The wave runs back down the body about a body length long, barely moving the head, swelling sharply toward the
          // tail, which sways about a tenth of a length each way at full effort; the tail fin follows the bend on through.
          const envelope = back.mul(back).mul(0.85).add(back.mul(0.1)).add(0.05) as any;
          const beat = sin(S.x.sub(back.mul(5.6))) as any;
          const bend = beat.mul(envelope).mul(S.y.mul(0.11)).add(S.z.mul(p.x.sub(0.1).mul(p.x.sub(0.1)))) as any;
          // The paired fins row in and out from the flanks, hardest when the fish hangs still and holds its place by them.
          const row = float(1.15).sub(S.y) as any;
          const out = fin.mul(smoothstep(0.02, 0.05, abs(p.z))).mul(sin(sea.clock.mul(3.1).add(H.w.mul(2))).mul(row).mul(shark ? 0.08 : 0.35)) as any;
          const local = vec3(p.x, p.y.mul(kind.deep), p.z.mul(out.add(1)).add(bend)) as any;
          const f = normalize(H.xyz.add(vec3(1e-4, 0, 0))) as any;
          const level = normalize(vec3(f.z.negate(), 0, f.x).add(vec3(0, 0, 1e-4))) as any;
          // Leaning a little into its turns.
          const roll = S.z.mul(-0.9).clamp(-0.35, 0.35) as any;
          const flat = level.cross(f) as any;
