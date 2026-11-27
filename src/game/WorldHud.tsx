import { useCallback, useEffect, useRef, useState } from "react";
import { BODY_LABEL, game, useGame, type IslandsApp } from "./store";

// ------------------------------------------------------------------------------------------------ map colouring
type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};
const C = {
  surf: hex("#6fc8c2"),
  reef: hex("#2f93b3"),
  sea: hex("#175180"),
  abyss: hex("#0b2846"),
  lakeS: hex("#5f9b80"),
  lakeD: hex("#1d4945"),
  riverS: hex("#8a8a55"),
  riverD: hex("#56603a"),
  swampS: hex("#62592f"),
  swampD: hex("#3b3420"),
  marsh: hex("#5f6539"),
  sand: hex("#ddcb9b"),
  low: hex("#83a85c"),
  mid: hex("#5c8743"),
  hill: hex("#7b7e4c"),
  rock: hex("#8e887c"),
  peak: hex("#cfcbc2"),
  fog: hex("#13304a"),
  fogLine: hex("#21496b"),
};

const sample = { h: 0, wet: 0, swamp: 0, fresh: 0, body: 1, level: 0, seaDist: 0 };

// Paint the archipelago round virtual (cx, cz) at mpp metres per pixel into an ImageData.
function paint(app: IslandsApp, img: ImageData, cx: number, cz: number, mpp: number) {
  const { width: w, height: h, data: px } = img;
  const d = app.data;
  const H = new Float32Array((w + 2) * (h + 2));
  const B = new Uint8Array(w * h);
  const S = new Float32Array(w * h);
  const U = new Uint8Array(w * h);
  const x0 = cx - (w / 2) * mpp, z0 = cz - (h / 2) * mpp;
  for (let j = -1; j <= h; j++)
    for (let i = -1; i <= w; i++) {
      const vx = x0 + (i + 0.5) * mpp, vz = z0 + (j + 0.5) * mpp;
      d.worldSample(vx, vz, sample);
      H[(j + 1) * (w + 2) + i + 1] = sample.h;
      if (i >= 0 && j >= 0 && i < w && j < h) {
        const k = j * w + i;
        B[k] = sample.body;
        S[k] = sample.swamp;
        const desc = d.descriptorAt(vx, vz);
        if (desc && !d.gridFor(desc) && Math.hypot(vx - desc.cx, vz - desc.cz) < (desc.half ?? desc.span / 2) * 0.72) U[k] = 1;
      }
    }
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const hh = H[(j + 1) * (w + 2) + i + 1];
      const b = B[k];
      let c: RGB;
      if (U[k]) c = (i + j) % 7 < 2 ? C.fogLine : C.fog;
      else if (b === 2) c = mix(C.lakeS, C.lakeD, -hh / 12);
      else if (b === 3 || b === 4) c = mix(C.riverS, C.riverD, -hh / 6);
      else if (b === 5) c = hh > 0.05 ? C.marsh : mix(C.swampS, C.swampD, -hh / 3);
      else if (b === 6) c = mix(mix(C.riverS, C.reef, 0.5), C.sea, -hh / 14);
      else if (hh < 0) {
        const dd = -hh;
        c = dd < 2 ? mix(C.surf, C.reef, dd / 2) : dd < 10 ? mix(C.reef, C.sea, (dd - 2) / 8) : mix(C.sea, C.abyss, (dd - 10) / 40);
      } else {
        c = hh < 1.6 ? C.sand : hh < 30 ? mix(C.low, C.mid, hh / 30) : hh < 120 ? mix(C.mid, C.hill, (hh - 30) / 90) : hh < 260 ? mix(C.hill, C.rock, (hh - 120) / 140) : mix(C.rock, C.peak, (hh - 260) / 160);
        if (S[k] > 0.2) c = mix(c, C.marsh, S[k] * 0.8);
        // hill shade from the north-west
        const gx = H[(j + 1) * (w + 2) + i + 2] - H[(j + 1) * (w + 2) + i];
        const gz = H[(j + 2) * (w + 2) + i + 1] - H[j * (w + 2) + i + 1];
        const shade = Math.min(1.35, Math.max(0.55, 1 - ((gx + gz) / (2 * mpp)) * 0.9));
        c = [c[0] * shade, c[1] * shade, c[2] * shade];
      }
      const o = k * 4;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = 255;
    }
}

// ------------------------------------------------------------------------------------------------ icons
const I = {
  beach: (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M4 12a8 8 0 0 1 16 0z" />
      <path d="M12 12v6" />
      <path d="M3 20c2-1.3 4-1.3 6 0s4 1.3 6 0 4-1.3 6 0" />
    </svg>
  ),
  lake: (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10z" />
      <path d="M9.5 14.5a2.6 2.6 0 0 0 2.4 2.4" />
    </svg>
  ),
  river: (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M3 7c3-2 6 2 9 0s6-2 9 0" />
      <path d="M3 12c3-2 6 2 9 0s6-2 9 0" />
      <path d="M3 17c3-2 6 2 9 0s6-2 9 0" />
    </svg>
  ),
  swamp: (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M7 19V9M12 19V5M17 19v-8" />
      <path d="M7 9c-1.2-.8-1.2-2.6 0-3.4 1.2.8 1.2 2.6 0 3.4zM17 11c-1.2-.8-1.2-2.6 0-3.4 1.2.8 1.2 2.6 0 3.4z" />
      <path d="M3 20.5c3-1.3 6 1.3 9 0s6-1.3 9 0" />
    </svg>
  ),
  dive: (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <rect x="3" y="7" width="15" height="8" rx="3.5" />
      <path d="M10.5 15v-2M18 10h1.5a1.5 1.5 0 0 1 1.5 1.5V19" />
      <circle cx="8" cy="20" r="1" />
      <circle cx="12.5" cy="19" r="0.7" />
    </svg>
  ),
};

type Kind = "beach" | "lake" | "river" | "swamp";
const KINDS: { kind: Kind; label: string; tint: string }[] = [
  { kind: "beach", label: "Beach", tint: "#e8d39c" },
  { kind: "lake", label: "Lake", tint: "#7fc0a2" },
  { kind: "river", label: "River", tint: "#b8b478" },
  { kind: "swamp", label: "Wetland", tint: "#9aa266" },
];

// cycling through the nearest distinct features of a kind on repeated presses
const cycle = { kind: "" as string, k: 0 };
export async function goTo(kind: Kind) {
  const app = game.app;
  if (!app || game.get().busy) return;
  cycle.k = cycle.kind === kind ? cycle.k + 1 : 0;
  cycle.kind = kind;
  const label = KINDS.find((x) => x.kind === kind)!.label;
  const spot = app.findFeature(kind, cycle.k);
  if (!spot) {
    game.toast(`No ${label.toLowerCase()} on the islands raised so far — open the map and travel to a new island.`);
    return;
  }
  game.set({ busy: true, mapOpen: false });
  await app.teleport(spot.vx, spot.vz, { yaw: spot.yaw, label: `To the ${label.toLowerCase()}…` });
  game.set({ busy: false });
  game.toast(`${label} · press ${kind === "beach" ? "the map for more" : "Dive to go under"}`);
}

// ------------------------------------------------------------------------------------------------ minimap
function MiniMap() {
  const snap = useGame((s) => s.snap);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef({ vx: 1e9, vz: 1e9, t: 0 });
  const SIZE = 96;
  const MPP = 9;
  useEffect(() => {
    if (!snap || !canvas.current || !game.app) return;
    const now = performance.now();
    const l = last.current;
    if (Math.hypot(snap.vx - l.vx, snap.vz - l.vz) < 22 && now - l.t < 4000) return;
    last.current = { vx: snap.vx, vz: snap.vz, t: now };
    const ctx = canvas.current.getContext("2d")!;
    const img = ctx.createImageData(SIZE, SIZE);
    paint(game.app, img, snap.vx, snap.vz, MPP);
    ctx.putImageData(img, 0, 0);
  }, [snap]);
  const angle = snap ? Math.atan2(snap.dirX, -snap.dirZ) : 0;
  const off = snap ? { x: (snap.vx - last.current.vx) / MPP, y: (snap.vz - last.current.vz) / MPP } : { x: 0, y: 0 };
  return (
    <button
      onClick={() => game.set({ mapOpen: true })}
      title="Map (M)"
      className="group relative h-[88px] w-[88px] overflow-hidden rounded-full border border-white/25 bg-[#0a1a28]/70 shadow-[0_6px_24px_rgba(0,0,0,0.35)] backdrop-blur-md transition hover:border-white/50 sm:h-[104px] sm:w-[104px]"
    >
      <canvas ref={canvas} width={SIZE} height={SIZE} className="absolute inset-0 h-full w-full opacity-95" style={{ imageRendering: "auto", transform: `translate(${-off.x}%, ${-off.y}%)` }} />
      <div className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_14px_rgba(0,0,0,0.55)]" />
      <span className="pointer-events-none absolute left-1/2 top-[3px] -translate-x-1/2 text-[9px] font-bold tracking-wider text-white/80 drop-shadow">N</span>
      <span className="pointer-events-none absolute left-1/2 top-1/2 h-0 w-0 -translate-x-1/2 -translate-y-1/2" style={{ transform: `translate(-50%, -50%) rotate(${angle}rad)` }}>
        <svg viewBox="-8 -10 16 18" className="absolute -left-[7px] -top-[9px] h-[18px] w-[14px] drop-shadow">
          <path d="M0 -9 L6.5 7 L0 3.5 L-6.5 7 Z" fill="#ffffff" stroke="#0b2238" strokeWidth="1.2" />
        </svg>
      </span>
      <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-black/35 px-1.5 text-[8.5px] font-semibold uppercase tracking-[0.12em] text-white/85 opacity-0 transition group-hover:opacity-100">Map</span>
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ the full map
function MapPanel() {
  const snap = useGame((s) => s.snap);
  const busy = useGame((s) => s.busy);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState(() => ({ cx: snap?.vx ?? 0, cz: snap?.vz ?? 0, mpp: 6 }));
  const [size, setSize] = useState({ w: 600, h: 600 });
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [target, setTarget] = useState<{ vx: number; vz: number; info: string } | null>(null);
  const gesture = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // progressive paint: coarse at once, finer a moment later
  useEffect(() => {
    if (!canvas.current || !game.app) return;
    const ctx = canvas.current.getContext("2d")!;
    let cancelled = false;
    const draw = (div: number) => {
      if (cancelled) return;
      const w = Math.max(8, Math.round(size.w / div)), h = Math.max(8, Math.round(size.h / div));
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const octx = off.getContext("2d")!;
      const img = octx.createImageData(w, h);
      paint(game.app, img, view.cx, view.cz, view.mpp * div);
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, size.w, size.h);
      setDrag({ x: 0, y: 0 });
    };
    draw(6);
    const id = window.setTimeout(() => draw(2), 60);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [view, size]);

  const toVirtual = (px: number, py: number) => ({ vx: view.cx + (px - size.w / 2) * view.mpp, vz: view.cz + (py - size.h / 2) * view.mpp });
  const toScreen = (vx: number, vz: number) => ({ x: (vx - view.cx) / view.mpp + size.w / 2 + drag.x, y: (vz - view.cz) / view.mpp + size.h / 2 + drag.y });
  const zoom = useCallback((f: number, px?: number, py?: number) => {
    setView((v) => {
      const mpp = Math.min(80, Math.max(0.8, v.mpp * f));
      if (px === undefined || py === undefined) return { ...v, mpp };
      // keep the point under the cursor fixed
      const ax = v.cx + (px - size.w / 2) * v.mpp, az = v.cz + (py - size.h / 2) * v.mpp;
      return { cx: ax - (px - size.w / 2) * mpp, cz: az - (py - size.h / 2) * mpp, mpp };
    });
  }, [size]);

  const describe = (vx: number, vz: number) => {
    const d = game.app.data;
    const desc = d.descriptorAt(vx, vz);
    if (desc && !d.gridFor(desc) && Math.hypot(vx - desc.cx, vz - desc.cz) < (desc.half ?? desc.span / 2) * 0.72) return "Uncharted island — raised on arrival";
    d.worldSample(vx, vz, sample);
    const b = sample.body;
    const name = b === 2 ? "Lake" : b === 3 || b === 4 ? "River" : b === 5 ? "Wetland" : b === 6 ? "Estuary" : sample.h < 0 ? "Open sea" : sample.h < 1.6 ? "Beach" : "Land";
    return sample.h < 0 ? `${name} · ${(-sample.h).toFixed(1)} m deep` : `${name} · ${sample.h.toFixed(0)} m up`;
  };

  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (Math.hypot(dx, dy) > 4) g.moved = true;
    if (g.moved) setDrag({ x: dx, y: dy });
  };
  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (g.moved) {
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      setView((v) => ({ ...v, cx: v.cx - dx * v.mpp, cz: v.cz - dy * v.mpp }));
    } else {
      const p = toVirtual(e.clientX - r.left, e.clientY - r.top);
      setTarget({ ...p, info: describe(p.vx, p.vz) });
    }
  };

  const teleport = async () => {
    if (!target || busy) return;
    game.set({ busy: true, mapOpen: false });
    await game.app.teleport(target.vx, target.vz, { label: "Travelling…" });
    game.set({ busy: false });
  };

  const me = snap ? toScreen(snap.vx, snap.vz) : null;
  const angle = snap ? Math.atan2(snap.dirX, -snap.dirZ) : 0;
  const pin = target ? toScreen(target.vx, target.vz) : null;
  const boat = (() => {
    const a = game.app;
    if (!a?.boatCtl) return null;
    return toScreen(a.boatCtl.position.x + a.data.offsetX, a.boatCtl.position.z + a.data.offsetZ);
  })();
  const scaleM = view.mpp * 80;
  const scaleText = scaleM >= 1000 ? `${(scaleM / 1000).toFixed(scaleM >= 10000 ? 0 : 1)} km` : `${Math.round(scaleM)} m`;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#02080e]/55 p-3 backdrop-blur-[3px]" onClick={(e) => e.target === e.currentTarget && game.set({ mapOpen: false })}>
      <div className="relative flex h-[min(86vh,780px)] w-[min(94vw,780px)] flex-col overflow-hidden rounded-[22px] border border-white/15 bg-[#081723]/90 text-[#e8f2f8] shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#9fc3d8]">Chart</span>
          {KINDS.map(({ kind, label, tint }) => (
            <button key={kind} disabled={busy} onClick={() => goTo(kind)} className="flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.06] py-1 pl-2 pr-3 text-xs font-medium transition hover:bg-white/[0.12] disabled:opacity-40">
              <span style={{ color: tint }}>{I[kind]}</span>
              {label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => snap && setView((v) => ({ ...v, cx: snap.vx, cz: snap.vz }))} className="rounded-full border border-white/12 bg-white/[0.06] px-3 py-1 text-xs hover:bg-white/[0.12]">
              ◎ Me
            </button>
            <button onClick={() => game.set({ mapOpen: false })} aria-label="Close map" className="h-7 w-7 rounded-full border border-white/12 bg-white/[0.06] text-sm hover:bg-white/[0.14]">
              ✕
            </button>
          </div>
        </div>
        <div
          ref={wrap}
          className="relative flex-1 cursor-crosshair touch-none overflow-hidden bg-[#0b2846]"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => (gesture.current = null)}
          onWheel={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            zoom(e.deltaY > 0 ? 1.22 : 1 / 1.22, e.clientX - r.left, e.clientY - r.top);
          }}
        >
          <canvas ref={canvas} width={size.w} height={size.h} className="absolute inset-0" style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }} />
          {boat && (
            <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-[13px] drop-shadow" style={{ left: boat.x, top: boat.y }} title="Your boat">
              ⛵
            </div>
          )}
          {me && (
            <div className="pointer-events-none absolute" style={{ left: me.x, top: me.y, transform: `translate(-50%, -50%) rotate(${angle}rad)` }}>
              <div className="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/15" />
              <svg viewBox="-8 -10 16 18" className="relative h-[20px] w-[16px] drop-shadow">
                <path d="M0 -9 L6.5 7 L0 3.5 L-6.5 7 Z" fill="#fff" stroke="#0b2238" strokeWidth="1.2" />
              </svg>
            </div>
          )}
          {pin && (
            <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-full" style={{ left: pin.x, top: pin.y }}>
              <svg viewBox="0 0 24 32" className="h-7 w-5 drop-shadow-lg">
                <path d="M12 31C12 31 22 18.5 22 11A10 10 0 0 0 2 11C2 18.5 12 31 12 31Z" fill="#f6c453" stroke="#3a2a05" strokeWidth="1.4" />
                <circle cx="12" cy="11" r="3.6" fill="#3a2a05" />
              </svg>
            </div>
          )}
          <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-xl border border-white/15 bg-[#081723]/80 backdrop-blur" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => zoom(1 / 1.6)} className="h-9 w-9 text-lg hover:bg-white/10" aria-label="Zoom in">
              +
            </button>
            <div className="h-px bg-white/10" />
            <button onClick={() => zoom(1.6)} className="h-9 w-9 text-lg hover:bg-white/10" aria-label="Zoom out">
              −
            </button>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-[#081723]/70 px-2 py-1 text-[10.5px] text-white/80">
            <span className="block h-[3px] w-[80px] rounded bg-white/80" />
            {scaleText}
          </div>
          {target && (
            <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-[#081723]/90 py-1 pl-3.5 pr-1 text-xs shadow-xl backdrop-blur" onPointerDown={(e) => e.stopPropagation()}>
              <span className="whitespace-nowrap text-white/85">{target.info}</span>
              <button disabled={busy} onClick={teleport} className="rounded-full bg-[#f6c453] px-3 py-1.5 font-semibold text-[#2a1d02] transition hover:bg-[#ffd772] disabled:opacity-50">
                Teleport
              </button>
              <button onClick={() => setTarget(null)} className="h-6 w-6 rounded-full text-white/60 hover:bg-white/10" aria-label="Clear">
                ✕
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-white/10 px-3.5 py-2 text-[10.5px] text-white/70">
          {[
            ["#2f93b3", "Sea"],
            ["#3c7466", "Lake"],
            ["#737650", "River"],
            ["#4c4628", "Wetland"],
            ["#ddcb9b", "Beach"],
            ["#6e9550", "Land"],
            ["#21496b", "Uncharted"],
          ].map(([c, l]) => (
            <span key={l} className="flex items-center gap-1.5">
              <i className="block h-2.5 w-2.5 rounded-sm" style={{ background: c }} />
              {l}
            </span>
          ))}
          <span className="ml-auto hidden text-white/45 sm:inline">drag to pan · scroll to zoom · tap to pick a place</span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the overlay
export function WorldHud({ onDive }: { onDive: () => void }) {
  const mapOpen = useGame((s) => s.mapOpen);
  const busy = useGame((s) => s.busy);
  const snap = useGame((s) => s.snap);
  const [canDive, setCanDive] = useState(false);
  const lastCheck = useRef(0);

  useEffect(() => {
    if (!snap || !game.app) return;
    const now = performance.now();
    if (now - lastCheck.current < 600) return;
    lastCheck.current = now;
    setCanDive(!!game.app.diveSpot());
  }, [snap]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code === "KeyM") game.set({ mapOpen: !game.get().mapOpen });
      else if (e.code === "Escape" && game.get().mapOpen) game.set({ mapOpen: false });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const inWater = snap && snap.body !== "land" && snap.depth > 0.6;
  return (
    <>
      {/* top-right: the minimap, with the four places beneath it */}
      <div className="fixed right-3 top-[62px] z-[48] flex flex-col items-end gap-2 min-[560px]:top-3">
        <MiniMap />
        <div className="mr-[22px] flex flex-col gap-1.5 sm:mr-[30px]">
          {KINDS.map(({ kind, label, tint }) => (
            <button
              key={kind}
              disabled={busy}
              onClick={() => goTo(kind)}
              className="group relative flex h-[34px] w-[34px] items-center justify-center rounded-full border border-white/20 bg-[#0a1a28]/62 text-white shadow-lg backdrop-blur-md transition hover:border-white/45 disabled:opacity-40"
              aria-label={`Teleport to the nearest ${label.toLowerCase()}`}
            >
              <span style={{ color: tint }}>{I[kind]}</span>
              <span className="pointer-events-none absolute right-[42px] top-1/2 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-full bg-[#0a1a28]/85 px-2.5 py-1 text-[11px] font-medium text-white/90 opacity-0 shadow-lg transition group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:opacity-100">
                {label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* bottom-right, above the run button: dive — bright when there is water to dive into */}
      <button
        onClick={onDive}
        disabled={busy}
        className={`fixed bottom-[108px] right-[18px] z-[46] flex h-[62px] w-[62px] flex-col items-center justify-center rounded-full border text-[#eaf6ff] backdrop-blur-md transition duration-300 ${
          canDive ? "border-teal-200/70 bg-[#0f5e6b]/75 shadow-[0_0_22px_rgba(94,234,212,0.35)]" : "border-white/25 bg-[#0a1622]/45 opacity-70"
        }`}
        aria-label="Dive"
        title="Dive (4)"
      >
        {I.dive}
        <span className="-mt-0.5 text-[9px] font-semibold uppercase tracking-[0.14em]">Dive</span>
        {canDive && inWater && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 animate-ping rounded-full bg-teal-200/80" />}
      </button>

      {mapOpen && <MapPanel />}
      <Toast />
      {snap && snap.body !== "land" && snap.body !== "sea" && (
        <div className="pointer-events-none fixed left-1/2 top-3 z-[44] -translate-x-1/2 rounded-full bg-[#0a1622]/55 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-white/80 backdrop-blur-md">
          {BODY_LABEL[snap.body]}
        </div>
      )}
    </>
  );
}

function Toast() {
  const toast = useGame((s) => s.toast);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setShow(true);
    const id = window.setTimeout(() => setShow(false), 3600);
    return () => window.clearTimeout(id);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className={`pointer-events-none fixed bottom-[188px] left-1/2 z-[90] max-w-[86vw] -translate-x-1/2 rounded-2xl border border-white/15 bg-[#0a1622]/80 px-4 py-2 text-center text-[12.5px] text-[#e8f2f8] shadow-xl backdrop-blur-md transition duration-300 ${show ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"}`}>
      {toast.text}
    </div>
  );
}
