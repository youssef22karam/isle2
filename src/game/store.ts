import { useSyncExternalStore } from "react";

// The shared state between the WebGPU island world (vanilla engine in src/isle) and the React overlay.
export type Snapshot = {
  x: number;
  z: number;
  vx: number;
  vz: number;
  dirX: number;
  dirZ: number;
  mode: string;
  body: string;
  depth: number;
  shifting: boolean;
};

export type DiveSpot = { x: number; z: number; body: string; depth: number; dirX: number; dirZ: number };

type State = {
  ready: boolean;
  diving: DiveSpot | null;
  snap: Snapshot | null;
  toast: { text: string; at: number } | null;
  mapOpen: boolean;
  busy: boolean;
};

let state: State = { ready: false, diving: null, snap: null, toast: null, mapOpen: false, busy: false };
const listeners = new Set<() => void>();

// The island app (src/isle/islands-main.js IslandsApp) once booted. Loosely typed: it is plain JS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IslandsApp = any;

export const game = {
  app: null as IslandsApp,
  get: () => state,
  set(partial: Partial<State>) {
    state = { ...state, ...partial };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  toast(text: string) {
    game.set({ toast: { text, at: performance.now() } });
  },
};

export function useGame<T>(select: (s: State) => T): T {
  return useSyncExternalStore(game.subscribe, () => select(state), () => select(state));
}

export const BODY_LABEL: Record<string, string> = {
  sea: "Open sea",
  lake: "Lake",
  river: "River",
  swamp: "Wetland",
  land: "Land",
};
