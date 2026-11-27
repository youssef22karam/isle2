import { useEffect, useRef } from "react";
import "./isle/isle.css";
import { bootIslands } from "./isle/islands-main.js";
import DiveView from "./dive/DiveView";
import { WorldHud } from "./game/WorldHud";
import { game, useGame, type DiveSpot, type Snapshot } from "./game/store";
import { sound } from "./kelp/engine/sound";

// Tidewater Isles: the WebGPU archipelago (src/isle — sea, boat, sky, island29 terrain with its lakes, rivers and
// wetlands, now calm and coloured by kind) and, under any of that water, kelp3's living kelp world (src/kelp) grown
// over the real bed (src/dive). The React layer only adds the overlay: minimap, places, map + teleport, dive.

function startDive() {
  const app = game.app;
  const st = game.get();
  if (!app || st.busy || st.diving) return;
  const spot: DiveSpot | null = app.diveSpot();
  if (!spot) {
    game.toast("No water deep enough here — find a lake, river or wetland (the buttons under the map take you there).");
    return;
  }
  document.exitPointerLock?.();
  app.pause();
  document.body.classList.add("diving");
  try {
    sound.setMuted(false);
  } catch {
    /* sound is optional */
  }
  game.set({ diving: spot, mapOpen: false });
}

function endDive(x: number, z: number, dir: { x: number; z: number }) {
  const app = game.app;
  try {
    sound.setMuted(true);
  } catch {
    /* sound is optional */
  }
  if (app) {
    app.surfaceAt(x, z, dir);
    app.resume();
  }
  document.body.classList.remove("diving");
  game.set({ diving: null });
}

export default function App() {
  const host = useRef<HTMLDivElement>(null);
  const ready = useGame((s) => s.ready);
  const diving = useGame((s) => s.diving);

  useEffect(() => {
    if (!host.current) return;
    bootIslands(host.current, {
      onReady: (app: unknown) => {
        game.app = app;
        game.set({ ready: true });
      },
      onTick: (snap: Snapshot) => {
        if (!game.get().diving) game.set({ snap });
      },
      onDiveRequest: () => startDive(),
    }).catch(() => {
      /* the loader shows the reason */
    });
  }, []);

  return (
    <>
      <div id="app" ref={host} />
      {ready && !diving && <WorldHud onDive={startDive} />}
      {diving && game.app && <DiveView app={game.app} spot={diving} onExit={endDive} />}
    </>
  );
}
