import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { orbitPoint } from "../kelp/engine/controls";
import { floorAt } from "../kelp/kelp";
import { SURFACE } from "../kelp/water";

// The diver's input, written by the DOM (keys, drag-look, the touch stick and up / down pads) and read each frame.
export const swim = {
  keys: new Set<string>(),
  joyX: 0,
  joyY: 0,
  up: false,
  down: false,
  fast: false,
  lookX: 0,
  lookY: 0,
  yaw: 0,
  pitch: -0.18,
};

const key = (...codes: string[]) => codes.some((c) => swim.keys.has(c));

// First-person swimming: the view turns by drag, W swims where you look (pitch included), Space / C rise and sink,
// Shift kicks harder. Water drag eases every start and stop. The eye stays between the bed and the surface.
export function SwimRig({ onMove, onRecenter }: { onMove: (x: number, y: number, z: number) => void; onRecenter: (x: number, z: number) => void }) {
  const camera = useThree((s) => s.camera);
  const focus = useMemo(() => new THREE.Vector3(), []);
  const velocity = useMemo(() => new THREE.Vector3(), []);
  const wish = useMemo(() => new THREE.Vector3(), []);
  const pending = useRef(false);

  useEffect(() => {
    orbitPoint.current = focus;
    camera.rotation.order = "YXZ";
    return () => {
      orbitPoint.current = null;
    };
  }, [camera, focus]);

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    swim.yaw -= swim.lookX * 0.0034;
    swim.pitch = THREE.MathUtils.clamp(swim.pitch - swim.lookY * 0.0034, -1.45, 1.45);
    swim.lookX = 0;
    swim.lookY = 0;
    if (key("ArrowLeft")) swim.yaw += dt * 1.6;
    if (key("ArrowRight")) swim.yaw -= dt * 1.6;

    const forward = (key("KeyW", "ArrowUp") ? 1 : 0) - (key("KeyS", "ArrowDown") ? 1 : 0) - swim.joyY;
    const side = (key("KeyD") ? 1 : 0) - (key("KeyA") ? 1 : 0) + swim.joyX;
    const rise = (key("Space", "KeyE") || swim.up ? 1 : 0) - (key("KeyC", "KeyQ", "ControlLeft") || swim.down ? 1 : 0);
    const fast = swim.fast || key("ShiftLeft", "ShiftRight");

    const cy = Math.cos(swim.yaw), sy = Math.sin(swim.yaw), cp = Math.cos(swim.pitch), spch = Math.sin(swim.pitch);
    // view forward (three: -z) and right
    const fx = -sy * cp, fy = spch, fz = -cy * cp;
    const rx = cy, rz = -sy;
    wish.set(fx * forward + rx * side, fy * forward + rise, fz * forward + rz * side);
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(fast ? 3.4 : 1.7);
    velocity.lerp(wish, 1 - Math.exp(-dt * (wish.lengthSq() > 0 ? 2.6 : 1.4)));

    const p = camera.position;
    p.addScaledVector(velocity, dt);
    const bed = floorAt(p.x, p.z) + 0.35;
    const top = SURFACE - 0.22;
    if (p.y < bed) {
      p.y = bed;
      velocity.y = Math.max(0, velocity.y);
    }
    if (p.y > top) {
      p.y = top;
      velocity.y = Math.min(0, velocity.y);
    }
    // the bank: where the bed rises out of the water, slide back off it
    if (bed > top - 0.05) {
      p.addScaledVector(velocity, -dt * 1.05);
      velocity.multiplyScalar(0.4);
    }
    camera.rotation.set(swim.pitch, swim.yaw, 0, "YXZ");
    focus.set(p.x + fx * 4, p.y + fy * 4, p.z + fz * 4);
    onMove(p.x, p.y, p.z);

    // Far enough from the site's middle: the world is laid out again round the diver.
    if (!pending.current && Math.hypot(p.x, p.z) > 12.5) {
      pending.current = true;
      onRecenter(p.x, p.z);
      window.setTimeout(() => (pending.current = false), 900);
    }
  });
  return null;
}
