// park-reef.js — imported FIRST by islands-main.js, on purpose.
//
// tidewater's world layout gives its single bay a reef (WORLD.reef:
// centre (-78, 58), radius 58) and Terrain.js bakes that centre/radius
// into its terrain shader as a module-level template literal — i.e. at
// module-evaluation time, before islands-main's own code can run. Left
// alone, the archipelago would carry a soft pale "reef flat" disc at
// window-local (-78, 58) forever, reappearing at every floating-origin
// shift. The archipelago has no such reef, so park the centre far
// outside any terrain window (the reef weight is then 0 everywhere).
//
// This module must evaluate before Terrain.js's module body: ES modules
// evaluate depth-first in import order, and islands-main imports this
// file first, so the mutation lands before Terrain.js is reached.
import { WORLD } from '../world/WorldLayout.js';

WORLD.reef.center.set( 1e6, 0, 1e6 );
