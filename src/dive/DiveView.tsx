import { Canvas, extend, useThree } from "@react-three/fiber";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three/webgpu";
import { Post } from "../kelp/engine/Post";
import { useQuality } from "../kelp/engine/quality";
import { sound } from "../kelp/engine/sound";
import { Scene } from "../kelp/index";
import { floorAt } from "../kelp/kelp";
import { floorAssets } from "../kelp/procedural";
import { holding } from "../kelp/voices";
import { SURFACE } from "../kelp/water";
import { BODY_LABEL, type DiveSpot, type IslandsApp } from "../game/store";
import { applyLook, makeSite, surfaceFor, type Site } from "./site";
import { SwimRig, swim } from "./SwimRig";

// R3F's elements built from the WebGPU build of three (as kelp3's App does).
extend(THREE as unknown as Parameters<typeof extend>[0]);

class Guard extends Component<{ children: ReactNode; onExit: () => void }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message || String(error) };
  }
  render() {
    if (this.state.error)
      return (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#04161a] p-8 text-center text-teal-50">
          <div>
            <p className="mb-2 text-lg">The water could not be drawn on this device.</p>
            <p className="mb-5 text-sm opacity-60">{this.state.error}</p>
            <button onClick={this.props.onExit} className="rounded-full bg-teal-200/90 px-5 py-2 text-sm font-semibold text-[#062026]">
              Back to the surface
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

function CameraHandle({ onCamera }: { onCamera: (c: THREE.Camera) => void }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => onCamera(camera), [camera, onCamera]);
  return null;
}

type Readout = { you: number; bed: number; body: string };

export default function DiveView({ app, spot, onExit }: { app: IslandsApp; spot: DiveSpot; onExit: (x: number, z: number, dir: { x: number; z: number }) => void }) {
  const { tier } = useQuality();
  const fine = tier === "low" ? 0.5 : tier === "medium" ? 0.75 : 1;
  const [ready, setReady] = useState(false);
  const [shown, setShown] = useState(false);
  const [veil, setVeil] = useState(true);
  const [key, setKey] = useState(0);
  const siteRef = useRef<Site | null>(null);
  const camRef = useRef<THREE.Camera | null>(null);
  const [readout, setReadout] = useState<Readout>({ you: 0, bed: 0, body: spot.body });
  const lastReadout = useRef(0);
  const [hint, setHint] = useState(true);
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  // Lay out the first site and grow the floor's textures before the scene mounts (as kelp3 does).
  if (!siteRef.current) {
    const surface = surfaceFor(app, spot.x, spot.z);
    siteRef.current = makeSite(app, spot.x, spot.z, surface, true);
    applyLook(siteRef.current.body, siteRef.current.flow, true);
    swim.yaw = Math.atan2(-spot.dirX, -spot.dirZ);
    swim.pitch = -0.2;
  }
  const site = siteRef.current;
  const startY = Math.max(floorAt(0, 0) + 0.6, SURFACE - Math.min(1.4, site.depth * 0.45 + 0.3));

  useEffect(() => {
    const id = window.setTimeout(() => {
      floorAssets(fine > 0.6);
      setReady(true);
    }, 30);
    const hintId = window.setTimeout(() => setHint(false), 9000);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(hintId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keys + drag-to-look
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Escape" || e.code === "KeyF") return leave();
      swim.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    };
    const up = (e: KeyboardEvent) => swim.keys.delete(e.code);
    const blur = () => swim.keys.clear();
    let look: { id: number; x: number; y: number } | null = null;
    const pdown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-hud]")) return;
      look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const pmove = (e: PointerEvent) => {
      if (!look || e.pointerId !== look.id) return;
      // (holding a kelp stipe: the pull follows the pointer, the view stays put)
      if (holding.on) {
        look.x = e.clientX;
        look.y = e.clientY;
        return;
      }
      swim.lookX += (e.clientX - look.x) * (e.pointerType === "touch" ? 1.3 : 1);
      swim.lookY += (e.clientY - look.y) * (e.pointerType === "touch" ? 1.3 : 1);
      look.x = e.clientX;
      look.y = e.clientY;
    };
    const pup = (e: PointerEvent) => {
      if (look && e.pointerId === look.id) look = null;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    window.addEventListener("pointerdown", pdown);
    window.addEventListener("pointermove", pmove);
    window.addEventListener("pointerup", pup);
    window.addEventListener("pointercancel", pup);
    return () => {
      swim.keys.clear();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pointerdown", pdown);
      window.removeEventListener("pointermove", pmove);
      window.removeEventListener("pointerup", pup);
      window.removeEventListener("pointercancel", pup);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leave = () => {
    const c = camRef.current;
    const s = siteRef.current!;
    const x = s.cx + (c ? c.position.x : 0);
    const z = s.cz + (c ? c.position.z : 0);
    sound.setMuted?.(true);
    onExit(x, z, { x: -Math.sin(swim.yaw), z: -Math.cos(swim.yaw) });
  };

  // The world is laid out again round the diver: the same island bed, new growth, a short veil over the change.
  const recenter = (dx: number, dz: number) => {
    setVeil(true);
    window.setTimeout(() => {
      const old = siteRef.current!;
      const next = makeSite(app, old.cx + dx, old.cz + dz, old.surface, false);
      if (next.body !== old.body || next.body === "river") applyLook(next.body, next.flow, false);
      siteRef.current = next;
      const c = camRef.current;
      if (c) {
        c.position.x -= dx;
        c.position.z -= dz;
      }
      setReadout((r) => ({ ...r, body: next.body }));
      setKey((k) => k + 1);
      window.setTimeout(() => setVeil(false), 380);
    }, 260);
  };

  const onMove = (x: number, y: number, z: number) => {
    const now = performance.now();
    if (now - lastReadout.current < 200) return;
    lastReadout.current = now;
    setReadout({ you: Math.max(0, SURFACE - y), bed: Math.max(0, SURFACE - floorAt(x, z)), body: siteRef.current!.body });
  };

  const nearTop = readout.you < 0.6;

  return (
    <div className="fixed inset-0 z-[70] overflow-hidden bg-black select-none">
      <Guard onExit={leave}>
        {ready && (
          <Canvas
            className="absolute inset-0"
            dpr={tier === "high" ? [1, 1.25] : 1}
            camera={{ position: [0, startY, 0], fov: 62, near: 0.05, far: 160 }}
            gl={async (props) => {
              const renderer = new THREE.WebGPURenderer({ ...(props as object), antialias: false, powerPreference: "high-performance" } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
              await renderer.init();
              renderer.setClearColor(0x000000, 1);
              renderer.toneMapping = THREE.ACESFilmicToneMapping;
              return renderer;
            }}
            onCreated={() =>
              window.setTimeout(() => {
                setShown(true);
                setVeil(false);
              }, 250)
            }
          >
            <CameraHandle onCamera={(c) => (camRef.current = c)} />
            <SwimRig onMove={onMove} onRecenter={recenter} />
            <Scene key={key} />
            <Post range={5} />
          </Canvas>
        )}
        <div className="pointer-events-none fixed inset-0 z-[2]" style={{ background: "radial-gradient(circle at 50% 45%, transparent 50%, rgba(2, 12, 16, 0.6) 100%)" }} />
      </Guard>

      {/* veil: the plunge, and the re-laying of the world as the diver swims on */}
      <div className={`pointer-events-none fixed inset-0 z-[5] bg-[#03161b] transition-opacity duration-300 ${veil ? "opacity-100" : "opacity-0"}`} />
      {!shown && (
        <div className="fixed inset-0 z-[6] flex flex-col items-center justify-center text-teal-50">
          <div className="relative mb-5 h-14 w-14">
            <div className="absolute inset-0 animate-ping rounded-full bg-teal-300/20" />
            <div className="absolute inset-3 rounded-full bg-gradient-to-b from-teal-200/70 to-teal-700/40" />
          </div>
          <p className="text-xs uppercase tracking-[0.3em] text-teal-100/70">Diving into the {BODY_LABEL[spot.body]?.toLowerCase() ?? "water"}…</p>
        </div>
      )}

      {/* top: where you are, how deep, and the way up */}
      <div data-hud className="fixed left-1/2 top-3 z-[8] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-teal-100/15 bg-[#04161b]/65 p-1 pl-3.5 text-teal-50 shadow-xl backdrop-blur-md">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-teal-100/80">{BODY_LABEL[readout.body] ?? "Water"}</span>
        <span className="mx-1 h-4 w-px bg-teal-100/20" />
        <span className="font-mono text-xs tabular-nums text-teal-50/90">
          {readout.you.toFixed(1)}
          <span className="text-teal-100/50"> / {readout.bed.toFixed(1)} m</span>
        </span>
        <button
          onClick={leave}
          className={`ml-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${nearTop ? "bg-amber-200 text-[#2a1c05] shadow-[0_0_18px_rgba(253,230,138,0.55)]" : "bg-teal-200/85 text-[#052026] hover:bg-teal-100"}`}
        >
          ⤒ Surface
        </button>
      </div>

      {hint && !touch && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-[8] -translate-x-1/2 rounded-full bg-[#04161b]/60 px-4 py-2 text-[11px] text-teal-50/75 backdrop-blur-md">
          WASD swim · drag to look · Space rise · C sink · Shift kick · hold on a weed to pull it · F / Esc surface
        </div>
      )}

      {touch && <TouchSwim />}
    </div>
  );
}

// Touch: a stick on the left to swim, rise / sink pads and a kick toggle on the right; drag anywhere else to look.
function TouchSwim() {
  const knob = useRef<HTMLDivElement>(null);
  const [fast, setFast] = useState(false);
  const stick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const l = Math.hypot(dx, dy);
    const k = l > 1 ? 1 / l : 1;
    swim.joyX = dx * k;
    swim.joyY = dy * k;
    if (knob.current) knob.current.style.transform = `translate(calc(-50% + ${dx * k * 34}px), calc(-50% + ${dy * k * 34}px))`;
  };
  const release = () => {
    swim.joyX = 0;
    swim.joyY = 0;
    if (knob.current) knob.current.style.transform = "translate(-50%, -50%)";
  };
  const hold = (which: "up" | "down") => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      swim[which] = true;
    },
    onPointerUp: () => (swim[which] = false),
    onPointerCancel: () => (swim[which] = false),
  });
  const pad = "flex h-14 w-14 items-center justify-center rounded-full border border-teal-50/30 bg-[#04161b]/45 text-xl text-teal-50 backdrop-blur-md active:bg-teal-400/50";
  return (
    <>
      <div
        data-hud
        className="fixed bottom-5 left-5 z-[8] h-28 w-28 touch-none rounded-full border border-teal-50/30 bg-[#04161b]/35 backdrop-blur-sm"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          stick(e);
        }}
        onPointerMove={(e) => e.buttons && stick(e)}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <div ref={knob} className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border border-teal-50/60 bg-teal-50/35" />
      </div>
      <div data-hud className="fixed bottom-5 right-5 z-[8] flex touch-none flex-col items-center gap-2.5">
        <button className={pad} aria-label="Rise" {...hold("up")}>
          ▲
        </button>
        <button
          className={`${pad} h-11 w-11 text-xs font-semibold ${fast ? "bg-teal-400/60" : ""}`}
          onClick={() => {
            swim.fast = !swim.fast;
            setFast(swim.fast);
          }}
        >
          kick
        </button>
        <button className={pad} aria-label="Sink" {...hold("down")}>
          ▼
        </button>
      </div>
    </>
  );
}
