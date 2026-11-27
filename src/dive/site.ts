import { setClearings, setFloor, setForestPlaces } from "../kelp/kelp";
import { settings } from "../kelp/engine/settings";
import { LOOKS, type Look, type School } from "../kelp/versions";
import { aim, setSurface } from "../kelp/water";
import type { IslandsApp } from "../game/store";

// A dive site: kelp3's underwater world rebuilt over the real island terrain. The diver's frame is local to the site
// centre (cx, cz in the island engine's local metres); the water surface (sea level, y = 0 in the island world) sits at
// y = surface, so the bed is island height + surface. Everything kelp3 grows reads that bed through floorAt, so the
// giant kelp's stipes — sized as (surface − root) — and the depth-fitted sugar kelp and patches (sugar.tsx depthFit)
// all take their length from the depth of the water they stand in.

export type Body = "lake" | "river" | "swamp" | "sea";

export type Site = {
  cx: number;
  cz: number;
  surface: number;
  body: Body;
  depth: number;
  flow: { x: number; z: number } | null;
  plants: number;
};

const BASE: Look = JSON.parse(JSON.stringify(LOOKS.forest));

const schools = (list: [School["kind"], number][]): School[] => list.map(([kind, count]) => ({ kind, count }));

// Natural colours of the three freshwaters (and kelp3's own kelp forest for the open sea).
export const LOOK_OF: Record<Body, Partial<Look>> = {
  sea: {},
  lake: {
    label: "Lake",
    shallow: "#6ea88e",
    deep: "#0a2421",
    sun: "#fff2d2",
    murk: 0.075,
    absorb: [2.6, 1, 1.35],
    caustics: 0.95,
    shafts: 1.35,
    swell: 0.14,
    period: 6,
    current: [0.03, 0.012],
    blade: "#5f6d23",
    stipe: "#47531a",
    sand: "#8d8667",
    snow: 1.15,
    jellies: 0,
    exposure: 1.02,
    schools: schools([
      ["sardine", 70],
      ["sardine", 45],
      ["bass", 8],
      ["seabass", 4],
      ["garibaldi", 5],
      ["cod", 3],
      ["farjack", 30],
    ]),
  },
  river: {
    label: "River",
    shallow: "#929062",
    deep: "#232210",
    sun: "#fff0cc",
    murk: 0.17,
    absorb: [1.5, 1.2, 2.3],
    caustics: 0.6,
    shafts: 0.8,
    swell: 0.08,
    period: 5,
    blade: "#6d6c27",
    stipe: "#504b1c",
    sand: "#7e7459",
    snow: 1.7,
    jellies: 0,
    exposure: 1.05,
    schools: schools([
      ["sardine", 60],
      ["jack", 28],
      ["yellowtail", 6],
      ["bass", 5],
    ]),
  },
  swamp: {
    label: "Wetland",
    shallow: "#6f5b2c",
    deep: "#110b04",
    sun: "#ffd9a0",
    murk: 0.22,
    absorb: [1.2, 2.1, 3.8],
    caustics: 0.45,
    shafts: 0.6,
    swell: 0.03,
    period: 4,
    current: [0.012, 0.005],
    blade: "#4d5b1d",
    stipe: "#3d4415",
    sand: "#4c4131",
    snow: 2.1,
    jellies: 0,
    exposure: 1.12,
    schools: schools([
      ["sardine", 40],
      ["bass", 6],
      ["garibaldi", 4],
      ["seabass", 2],
    ]),
  },
};

export function bodyOf(name: string): Body {
  return name === "lake" || name === "river" || name === "swamp" ? name : "sea";
}

// Dress the water for a body: its colour, clarity and fish, and for a river a current running down its own channel.
export function applyLook(body: Body, flow: { x: number; z: number } | null, now: boolean) {
  const look = { ...BASE, ...LOOK_OF[body] } as Look;
  if (body === "river" && flow) look.current = [flow.x * 0.08, flow.z * 0.08];
  Object.assign(LOOKS.forest, look);
  settings.set("current", body === "river" ? 1.25 : body === "swamp" ? 0.08 : body === "lake" ? 0.22 : 0.35);
  aim(LOOKS.forest, now);
}

function lehmer(seed: number) {
  let s = Math.abs(Math.floor(seed)) % 2147483646 || 1;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

// The water column for a whole dive: deep enough for the deepest bed near the start, so the floor sits about y = 0.
export function surfaceFor(app: IslandsApp, cx: number, cz: number) {
  let deepest = 0;
  for (let r = 0; r <= 18; r += 3)
    for (let a = 0; a < 12; a++) {
      const h = app.data.heightAt(cx + Math.cos((a / 12) * Math.PI * 2) * r, cz + Math.sin((a / 12) * Math.PI * 2) * r);
      deepest = Math.max(deepest, -h);
    }
  return Math.min(24, Math.max(2.4, deepest + 0.3));
}

// Lay out a site round (cx, cz): the bed, where the giant kelp stand (deep water only), and bare patches for the crabs.
export function makeSite(app: IslandsApp, cx: number, cz: number, surface: number, first: boolean): Site {
  const data = app.data;
  const bed = (x: number, z: number) => data.heightAt(cx + x, cz + z) as number;
  if (first) setSurface(surface);
  setFloor((x, z) => Math.min(bed(x, z), 1.4) + surface);

  const here = data.waterAt(cx, cz);
  const body = bodyOf(here.body);
  const flow = body === "river" ? (data.flowAt(cx, cz) as { x: number; z: number } | null) : null;
  const random = lehmer(Math.round(cx * 7.13 + cz * 3.71) + 9973);

  // Giant kelp (or tall lake weed): only where the water is deep enough to hold a stand, spaced apart.
  const density = body === "lake" ? 0.75 : body === "sea" ? 0.6 : body === "river" ? 0.45 : 0.3;
  const places: [number, number, number][] = [];
  const shallowBest: { x: number; z: number; d: number }[] = [];
  for (let gz = -15; gz <= 15; gz += 3.2)
    for (let gx = -15; gx <= 15; gx += 3.2) {
      const x = gx + (random() - 0.5) * 2.4;
      const z = gz + (random() - 0.5) * 2.4;
      const r2 = x * x + z * z;
      if (r2 > 225 || r2 < 2.5) continue;
      const depth = -bed(x, z);
      if (depth > 0.9) shallowBest.push({ x, z, d: depth });
      if (depth < 3 || random() > density) continue;
      if (places.some((p) => Math.hypot(p[0] - x, p[1] - z) < 3.6)) continue;
      if (places.length < 8) places.push([x, z, 0.8 + random() * 0.45]);
    }
  // Always a couple of plants (kelp3's forest expects some), the deepest spots found, small.
  shallowBest.sort((a, b) => b.d - a.d);
  for (const s of shallowBest) {
    if (places.length >= 2) break;
    if (places.some((p) => Math.hypot(p[0] - s.x, p[1] - s.z) < 2.5)) continue;
    places.push([s.x, s.z, 0.6]);
  }
  while (places.length < 2) places.push([6 + places.length * 3, 6, 0.5]);
  setForestPlaces(places);

  // Two bare patches of bed near the diver for the crabs to walk.
  const clear: { x: number; z: number; r: number; crabs: number }[] = [];
  for (let t = 0; t < 80 && clear.length < 2; t++) {
    const a = random() * Math.PI * 2;
    const r = 2 + random() * 6;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (-bed(x, z) < 0.8) continue;
    if (places.some((p) => Math.hypot(p[0] - x, p[1] - z) < 1.8) || clear.some((c) => Math.hypot(c.x - x, c.z - z) < 2.5)) continue;
    clear.push({ x, z, r: 0.9 + random() * 0.3, crabs: clear.length ? 2 : 3 });
  }
  if (!clear.length && shallowBest[0]) clear.push({ x: shallowBest[0].x, z: shallowBest[0].z, r: 0.9, crabs: 2 });
  setClearings(clear);

  return { cx, cz, surface, body, depth: Math.max(0, -bed(0, 0)), flow, plants: places.length };
}
