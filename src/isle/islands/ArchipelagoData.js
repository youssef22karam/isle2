// ArchipelagoData — island29's infinite archipelago behind tidewater's
// TerrainData interface (my code; the interface contract is tidewater's).
//
// tidewater's terrain stack (TerrainGPU textures, Terrain CDLOD, ShoreField,
// ShoreWaves, ShoreSim, Breakers, WaterQuery) consumes ONE heightfield
// domain: `size` metres across, `res` texels, `origin` = -size/2, with
// heightAt() bilinear over the grid and -90 outside it. The domain is fixed
// at the world origin (Terrain.js centres its CDLOD there), so infinity is
// done with a floating origin:
//
//   virtual = local + offset        (offset in metres, multiples of 256)
//
// Everything in the engine lives in LOCAL coordinates. Only this provider
// knows the offset: its grid is filled by sampling the archipelago (see
// IslandGen.js — island29's own cell hash / descriptors / heightfields) at
// virtual coordinates. When the player strays too far from the local origin,
// the app shifts offset, refills this grid, and translates the player /
// boat / camera by the same delta — the virtual world never changes.
//
// Island grids are generated lazily and cached; refill() needs every island
// whose square intersects the window, so the app first calls
// missingIslands(), generates those (slow, seconds — with a progress
// overlay), then calls refill().
//
// Scale reconciliation: island29's terrain is already in metres with sea
// level y = 0 and its deep-sea floor at -40 — exactly tidewater's convention
// (sea level 0). No rescaling anywhere: heights are copied 1:1. Island spans
// (3.2-7.2 km) dwarf tidewater's 2048 m domain, which is fine: the window is
// a moving 2048 m peephole over the islands, and tidewater's ocean CDLOD
// already extends past the terrain domain to the horizon.

import { Noise2D } from '../util/Noise.js';
import {
	WORLD_SEED, ARCHIPELAGO, cellHasIsland, islandDescriptor,
	generateIslandGrid, generateIslandGridAsync, sampleIslandGrid,
	sampleIslandField, sampleIslandCode, seaDistance,
} from './IslandGen.js';

const CELL_SIZE = ARCHIPELAGO.cellSize;

const clamp = ( v, a, b ) => Math.min( b, Math.max( a, v ) );
const sstep = ( a, b, v ) => { const t = clamp( ( v - a ) / ( b - a ), 0, 1 ); return t * t * ( 3 - 2 * t ); };

// reusable record for worldSample (refill samples a million texels; the
// sampler must not allocate per texel)
const _sampleOut = { h: 0, wet: 0, swamp: 0, fresh: 0, body: 1, level: 0, seaDist: 0 };

export const SEA_FLOOR = - 40; // island29's deep-sea datum (its island grids fall off to exactly this)

export class ArchipelagoData {

	constructor( size = 2048, res = 1024, seed = WORLD_SEED ) {

		this.size = size;
		this.res = res;
		this.texel = size / res;
		this.origin = - size / 2;
		this.pads = [];
		this.rockSites = [];

		const n = res * res;
		this.heights = new Float32Array( n );
		this.rock = new Float32Array( n );
		this.sand = new Uint8Array( n );
		this.path = new Uint8Array( n );
		this.gully = new Uint8Array( n );
		this.seagrass = new Uint8Array( n );
		this.rubble = new Uint8Array( n );
		this.scarp = new Uint8Array( n );

		// island29 hydrology fields, sampled per window texel alongside the
		// heights (from the containing island's kn world — see IslandGen.js):
		// the terrain colouring (fillMasks) reads these so riverbanks, lake
		// shores and wetland ground shade like island29's own terrains.
		this.fWet = new Uint8Array( n ); // kn wet: inland-water cells
		this.fSwamp = new Float32Array( n ); // kn swamp: wetland ground 0..1
		this.fFresh = new Float32Array( n ); // kn fresh: freshwater influence 0..1
		this.fBody = new Uint8Array( n ); // kn body: 0 land 1 sea 2 lake 3 river 4 trib. channel 5 swamp 6 estuary
		this.fLevel = new Float32Array( n ); // kn level: local water level (0 = sea level; identically 0 in this archipelago)
		this.fSeaDist = new Float32Array( n ); // metres to the nearest sea cell (part12's cd)

		this.offsetX = 0;
		this.offsetZ = 0;
		this.seed = seed;
		this.islands = new Map(); // key -> { desc, grid|null }
		this._seabed = new Noise2D( ( seed ^ 0x5eed ) >>> 0 );
		this._grass = new Noise2D( ( seed ^ 0x9a55 ) >>> 0 );

	}

	// ------------------------------------------------------------ archipelago access

	// descriptor for the archipelago cell containing virtual (vx, vz), or null
	descriptorAt( vx, vz ) {

		const ix = Math.floor( ( vx + CELL_SIZE / 2 ) / CELL_SIZE );
		const iz = Math.floor( ( vz + CELL_SIZE / 2 ) / CELL_SIZE );
		const key = ix + ',' + iz;
		let e = this.islands.get( key );
		if ( ! e ) {

			e = { desc: cellHasIsland( ix, iz, this.seed ) ? islandDescriptor( ix, iz, this.seed ) : null, grid: null };
			this.islands.set( key, e );

		}
		return e.desc;

	}

	// every island whose square intersects the current window and whose grid
	// has not been generated yet (the app generates these, then refill()s)
	missingIslands() {

		const out = [];
		const x0 = this.offsetX - this.size / 2, x1 = this.offsetX + this.size / 2;
		const z0 = this.offsetZ - this.size / 2, z1 = this.offsetZ + this.size / 2;
		const ix0 = Math.floor( ( x0 + CELL_SIZE / 2 ) / CELL_SIZE ), ix1 = Math.floor( ( x1 + CELL_SIZE / 2 ) / CELL_SIZE );
		const iz0 = Math.floor( ( z0 + CELL_SIZE / 2 ) / CELL_SIZE ), iz1 = Math.floor( ( z1 + CELL_SIZE / 2 ) / CELL_SIZE );
		for ( let iz = iz0; iz <= iz1; iz ++ ) for ( let ix = ix0; ix <= ix1; ix ++ ) {

			if ( ! cellHasIsland( ix, iz, this.seed ) ) continue;
			const desc = islandDescriptor( ix, iz, this.seed );
			if ( desc.cx + desc.half < x0 || desc.cx - desc.half > x1 || desc.cz + desc.half < z0 || desc.cz - desc.half > z1 ) continue;
			const e = this.islands.get( desc.key );
			if ( ! e || ! e.grid ) out.push( desc );

		}
		return out;

	}

	generateIsland( desc ) {

		const grid = generateIslandGrid( desc );
		this.islands.set( desc.key, { desc, grid } );
		return grid;

	}

	// the same, pumped asynchronously (kn yields its own stage labels to
	// onProgress) so the loading overlay can paint while an island rises
	async generateIslandAsync( desc, onProgress ) {

		const grid = await generateIslandGridAsync( desc, onProgress );
		this.islands.set( desc.key, { desc, grid } );
		return grid;

	}

	// lakes of a generated island whose water level is genuinely above the
	// sea (level > 0.05): island29's generator designs every lake, river and
	// marsh at sea level (verified on 5 islands: the level field is
	// identically 0), so this is expected to always be empty — it exists so
	// the claim stays checked, not assumed.
	elevatedLakes( desc ) {

		const grid = this.gridFor( desc );
		if ( ! grid ) return null;
		return grid.lakes.filter( ( l ) => l.level > 0.05 );

	}

	gridFor( desc ) {

		const e = this.islands.get( desc.key );
		return e ? e.grid : null;

	}

	// gentle swell of the open-sea floor far from any island (the island grids
	// themselves bottom out at exactly SEA_FLOOR; this fades in only where no
	// island claims the point, so it can never lift a beach)
	seabedNoise( vx, vz ) {

		return this._seabed.fbm( vx / 900, vz / 900, 3 ) * 3.2 + this._seabed.fbm( vx / 260 + 9.7, vz / 260 - 4.1, 2 ) * 0.9;

	}

	// true archipelago height at VIRTUAL coordinates (metres, sea level 0)
	worldHeightAt( vx, vz ) {

		return this.worldSample( vx, vz, _sampleOut ).h;

	}

	// height + island29 hydrology fields at VIRTUAL coordinates. `out` is a
	// reusable record { h, wet, swamp, fresh, body, level, seaDist } — the
	// fields are the containing island's kn data, rim-faded exactly like the
	// heights so nothing steps at an island square's edge; open sea reports
	// body 1 (sea) and zeroes elsewhere.
	worldSample( vx, vz, out ) {

		const desc = this.descriptorAt( vx, vz );
		if ( desc ) {

			const lx = vx - desc.cx, lz = vz - desc.cz;
			const edge = desc.half - Math.max( Math.abs( lx ), Math.abs( lz ) ); // >0 inside the island square
			if ( edge > - 500 ) {

				const grid = this.gridFor( desc );
				if ( grid ) {

					const s = sampleIslandGrid( grid, lx, lz );
					// the grid's own rim already falls to SEA_FLOOR; this fade is
					// seam insurance so window/world sampling is C0 across the rim
					const f = sstep( 0, 80, edge );
					out.h = SEA_FLOOR + ( s - SEA_FLOOR ) * f + this.seabedNoise( vx, vz ) * ( 1 - f );
					out.wet = f >= 0.5 ? sampleIslandCode( grid, grid.wet, lx, lz ) : 0;
					out.swamp = sampleIslandField( grid, grid.swamp, lx, lz ) * f;
					out.fresh = sampleIslandField( grid, grid.fresh, lx, lz ) * f;
					out.body = f >= 0.5 ? sampleIslandCode( grid, grid.body, lx, lz ) : 1;
					out.level = sampleIslandField( grid, grid.level, lx, lz );
					out.seaDist = sampleIslandField( grid, seaDistance( grid ), lx, lz );
					return out;

				}

			}

		}
		out.h = SEA_FLOOR + this.seabedNoise( vx, vz );
		out.wet = 0;
		out.swamp = 0;
		out.fresh = 0;
		out.body = 1;
		out.level = 0;
		out.seaDist = 0;
		return out;

	}

	// ------------------------------------------------------------ window fill

	// (re)fill heights + material masks for the window at the current offset.
	// All island grids intersecting the window must exist (missingIslands()).
	refill() {

		const { res, texel, origin, heights, fWet, fSwamp, fFresh, fBody, fLevel, fSeaDist } = this;
		const ox = this.offsetX, oz = this.offsetZ;
		const out = { h: 0, wet: 0, swamp: 0, fresh: 0, body: 1, level: 0, seaDist: 0 };
		for ( let j = 0; j < res; j ++ ) {

			const vz = oz + origin + ( j + 0.5 ) * texel;
			const jr = j * res;
			for ( let i = 0; i < res; i ++ ) {

				this.worldSample( ox + origin + ( i + 0.5 ) * texel, vz, out );
				const k = jr + i;
				heights[ k ] = out.h;
				fWet[ k ] = out.wet;
				fSwamp[ k ] = out.swamp;
				fFresh[ k ] = out.fresh;
				fBody[ k ] = out.body;
				fLevel[ k ] = out.level;
				fSeaDist[ k ] = out.seaDist;

			}

		}
		this.fillMasks();
		this.buildMinMax();
		this.buildInland();

	}

	// Material masks in tidewater's TerrainData semantics, derived from the
	// terrain AND island29's own hydrology fields (sampled into fWet /
	// fSwamp / fFresh / fBody / fLevel / fSeaDist by refill), following
	// island29's terrain-colouring rules (its part12 shader) expressed
	// through tidewater's splat contract (TerrainBake: splat R = sand,
	// G = path, B = gully on land / seagrass on the seabed, A = rubble on
	// the seabed / scarp face on land; rock rides the normal map's B):
	//   sand — forced below h 0.6 (the beach band); above it, vegetation
	//          takes over as smoothstep(2.2, 6.8, h) on gentle slopes (the
	//          sand channel fades so tidewater's meadow shows through);
	//          the seabed is sand that thins with depth. Along INLAND water
	//          (rivers, lakes, marshes) part12 mixes sunlit alluvial sand
	//          onto the banks by freshSoil — the same rule, keyed on
	//          bankH = h - level instead of h.
	//   rock — island29's far-rock + coastal-cliff + mountain-cliff masks
	//          (slope = 1 - N.y against height bands).
	//   gully — tidewater shades gully floors as soil that keeps plants
	//          (rock is suppressed there) and darkens its jungle floor:
	//          island29's damp capillary band along every inland waterline
	//          (part12's dampZone) and its swamp peat ground ride this
	//          channel.
	//   scarp — tidewater's layered eroded face: island29's stratified
	//          cutbanks on steep fresh banks.
	//   seagrass— patchy meadows on the 1.5-12 m seabed (tidewater's own
	//          band); on INLAND beds it carries island29's freshwater bed
	//          (kelp-meadow shade + swamp peat pockets under lakes, rivers
	//          and marshes — the seabed path renders splat B as the meadow).
	//   rubble  — stony debris aprons below rocky shores
	//   path    — stays 0: no paths without a village.
	// part12's own derived quantities, used verbatim in form:
	//   marsh     = the swamp field, with wet cells above water counted in
	//   freshSoil = max( fresh * smoothstep(65, 175, seaDist), marsh * 0.88 )
	//   dampZone  = freshSoil * (1 - smoothstep(0.04, 0.58 + 0.45*marsh, bankH))
	fillMasks() {

		const { res, texel, heights, rock, sand, gully, seagrass, rubble, scarp } = this;
		const { fWet, fSwamp, fFresh, fBody, fLevel, fSeaDist } = this;
		const inv = 1 / ( 2 * texel );
		for ( let j = 0; j < res; j ++ ) {

			const jm = Math.max( j - 1, 0 ) * res, jp = Math.min( j + 1, res - 1 ) * res, jr = j * res;
			for ( let i = 0; i < res; i ++ ) {

				const im = Math.max( i - 1, 0 ), ip = Math.min( i + 1, res - 1 );
				const k = jr + i;
				const h = heights[ k ];
				const gx = ( heights[ jr + ip ] - heights[ jr + im ] ) * inv;
				const gz = ( heights[ jp + i ] - heights[ jm + i ] ) * inv;
				const slope = Math.hypot( gx, gz );
				const sl = 1 - 1 / Math.hypot( 1, slope ); // island29's slope: 1 - N.y

				const level = fLevel[ k ];
				const bankH = h - level; // height above the local water level (part12's bankH)
				const body = fBody[ k ];
				const wet = fWet[ k ] > 0;
				const marsh = Math.max( fSwamp[ k ], ( wet && bankH > 0 ) ? 0.85 : 0 );
				const freshSoil = Math.max( fFresh[ k ] * sstep( 65, 175, fSeaDist[ k ] ), marsh * 0.88 );
				const inlandBed = bankH < 0 && ( body === 2 || body === 3 || body === 4 || body === 5 || body === 6 || wet );

				// rock: island29's far rock + coastal cliff + mountain cliff;
				// marsh ground and flat inland beds keep their soil (no rock)
				const farRock = sstep( 0.16, 0.36, sl ) * sstep( 3.2, 12, h );
				const coastCliff = sstep( 0.135, 0.30, sl ) * sstep( 2.4, 5.4, h );
				const mtnCliff = sstep( 0.175, 0.37, sl ) * sstep( 11, 32, h );
				let r = clamp( Math.max( farRock, coastCliff * 0.95, mtnCliff ), 0, 1 );
				r *= 1 - marsh * 0.85 * ( 1 - sstep( 0.3, 0.5, sl ) );
				if ( inlandBed ) r *= sstep( 0.18, 0.4, sl ); // only the channel walls stay rocky
				rock[ k ] = r;

				const x = this.origin + ( i + 0.5 ) * texel + this.offsetX;
				const z = this.origin + ( j + 0.5 ) * texel + this.offsetZ;
				let s, g = 0, sg = 0, sc = 0;

				if ( inlandBed ) {

					// under a river / lake / marsh: alluvial bed sand, with
					// island29's freshwater bed meadow (splat B on the seabed
					// path) — patchy, strongest in the shallows, peat-dark
					// where the swamp field is high
					const depth = - bankH;
					s = 1 - 0.55 * sstep( 8, 40, depth );
					const patch = sstep( 0.34, 0.58, this._grass.fbm( x * 0.011 + 3.7, z * 0.011 - 8.2, 4 ) );
					sg = patch * sstep( 0.25, 0.9, depth ) * ( 1 - sstep( 6, 11, depth ) )
						* ( 0.45 + 0.55 * marsh ) * ( 1 - r );
					g = marsh * 0.5 * ( 1 - sstep( 1.5, 4, depth ) ); // peat stain at the marsh bed edge

				} else if ( h < 0 ) {

					// open-sea bed (unchanged from the sea-only build)
					const depth = - h;
					s = 1 - 0.55 * sstep( 8, 40, depth ); // sandy seabed, thinning with depth
					sg = sstep( 0.34, 0.58, this._grass.fbm( x * 0.011 + 3.7, z * 0.011 - 8.2, 4 ) )
						* sstep( 1.5, 3.0, depth ) * ( 1 - sstep( 9, 12.5, depth ) ) * ( 1 - r ) * ( 1 - sstep( 0.3, 0.55, slope ) );

				} else {

					// dry land: island29's beach band + vegetation takeover
					if ( h < 0.6 ) s = 1; // island29 forces the sand branch at the shore
					else {

						const veg = sstep( 2.2, 6.8, h ) * ( 1 - sstep( 0.24, 0.46, sl ) );
						s = ( 1 - veg ) * ( 1 - 0.9 * sstep( 0.34, 0.60, sl ) ) * ( 1 - r * 0.5 );

					}
					// alluvial banks: sunlit sand along every inland waterline
					// (part12's bank/open-shore rules), fading up the bank
					if ( freshSoil > 0.01 && bankH >= 0 ) {

						const bankSand = freshSoil * ( 1 - sstep( 0.35, 1.65, bankH ) ) * ( 1 - sstep( 0.28, 0.5, sl ) );
						s = Math.max( s, bankSand );

					}
					// damp capillary band: dark wet soil hugging the waterline
					const damp = freshSoil * ( 1 - sstep( 0.04, 0.58 + 0.45 * marsh, bankH ) );
					g = Math.max( g, damp * 0.8 );
					// swamp peat / moss ground: dark wet soil where the marsh is
					if ( marsh > 0.03 ) {

						const peat = marsh * ( 1 - sstep( 2.0, 3.5, bankH ) ) * ( 1 - sstep( 0.3, 0.52, sl ) );
						g = Math.max( g, peat * 0.9 );
						s *= 1 - peat * 0.8;

					}
					// fertile flood margin: a touch of gully richness on low,
					// gentle, freshwater-fed ground (part12's flood basin)
					if ( freshSoil > 0.2 && bankH < 14 ) g = Math.max( g, freshSoil * 0.3 * ( 1 - sstep( 0.2, 0.42, sl ) ) );
					// stratified cutbanks: steep fresh banks take the scarp face
					if ( freshSoil > 0.3 && bankH > 0.02 && bankH < 2.8 ) {

						sc = freshSoil * sstep( 0.26, 0.45, sl ) * ( 1 - sstep( 0.55, 0.8, sl ) );

					}

				}
				sand[ k ] = Math.round( clamp( s, 0, 1 ) * 255 );
				gully[ k ] = Math.round( clamp( g, 0, 1 ) * 255 );
				seagrass[ k ] = Math.round( clamp( sg, 0, 1 ) * 255 );

				const depthSea = Math.max( 0, - h );
				const rb = r * sstep( 0.5, 2.0, depthSea ) * ( 1 - sstep( 6, 10, depthSea ) )
					* sstep( 0.45, 0.7, this._grass.fbm( x * 0.03 - 5.1, z * 0.03 + 6.4, 3 ) );
				rubble[ k ] = Math.round( clamp( rb, 0, 1 ) * 255 );
				scarp[ k ] = Math.round( clamp( sc, 0, 1 ) * 255 );

			}

		}
		this.path.fill( 0 );

	}

	setOffset( ox, oz ) {

		this.offsetX = ox;
		this.offsetZ = oz;

	}

	// ------------------------------------------------------------ TerrainData queries
	// (heightAt / normalAt / buildMinMax / boundsFor: the game's own code,
	// ported verbatim from world/TerrainData.js — the same port the earlier
	// tidewater-sea build verified bit-identical against the original)

	heightAt( x, z ) {

		const { res, texel, origin, heights } = this;
		const fx = ( x - origin ) / texel - 0.5, fz = ( z - origin ) / texel - 0.5;
		if ( fx < 0 || fz < 0 || fx >= res - 1 || fz >= res - 1 ) return - 90;
		const i = Math.floor( fx ), j = Math.floor( fz );
		const tx = fx - i, tz = fz - j;
		const k = j * res + i;
		const a = heights[ k ], b = heights[ k + 1 ], c = heights[ k + res ], d = heights[ k + res + 1 ];
		return ( a * ( 1 - tx ) + b * tx ) * ( 1 - tz ) + ( c * ( 1 - tx ) + d * tx ) * tz;

	}

	normalAt( x, z, out ) {

		const e = this.texel;
		const hx = this.heightAt( x + e, z ) - this.heightAt( x - e, z );
		const hz = this.heightAt( x, z + e ) - this.heightAt( x, z - e );
		out.set( - hx, 2 * e, - hz ).normalize();
		return out;

	}

	buildMinMax() {

		const tile = 8;
		const n = this.res / tile;
		this.mmTile = tile;
		this.mmN = n;
		const mn0 = new Float32Array( n * n ), mx0 = new Float32Array( n * n );
		const H = this.heights, res = this.res;
		for ( let tj = 0; tj < n; tj ++ ) for ( let ti = 0; ti < n; ti ++ ) {

			let mn = Infinity, mx = - Infinity;
			const jEnd = Math.min( res - 1, ( tj + 1 ) * tile ), iEnd = Math.min( res - 1, ( ti + 1 ) * tile );
			for ( let j = tj * tile; j <= jEnd; j ++ ) {

				const row = j * res;
				for ( let i = ti * tile; i <= iEnd; i ++ ) {

					const h = H[ row + i ];
					if ( h < mn ) mn = h;
					if ( h > mx ) mx = h;

				}

			}

			mn0[ tj * n + ti ] = mn;
			mx0[ tj * n + ti ] = mx;

		}

		this.mmMin = mn0;
		this.mmMax = mx0;
		this.mmLevels = [ { n, min: mn0, max: mx0 } ];
		let cur = this.mmLevels[ 0 ];
		while ( cur.n > 1 ) {

			const m = cur.n >> 1;
			const mn = new Float32Array( m * m ), mx = new Float32Array( m * m );
			for ( let j = 0; j < m; j ++ ) for ( let i = 0; i < m; i ++ ) {

				const a = ( 2 * j ) * cur.n + 2 * i, b = a + cur.n;
				mn[ j * m + i ] = Math.min( cur.min[ a ], cur.min[ a + 1 ], cur.min[ b ], cur.min[ b + 1 ] );
				mx[ j * m + i ] = Math.max( cur.max[ a ], cur.max[ a + 1 ], cur.max[ b ], cur.max[ b + 1 ] );

			}

			cur = { n: m, min: mn, max: mx };
			this.mmLevels.push( cur );

		}

	}

	boundsFor( x0, z0, x1, z1 ) {

		const { origin, texel, mmTile } = this;
		const span = Math.max( x1 - x0, z1 - z0 ) / ( texel * mmTile );
		const l = Math.max( 0, Math.min( this.mmLevels.length - 1, Math.ceil( Math.log2( Math.max( 1, span / 2 ) ) ) ) );
		const L = this.mmLevels[ l ];
		const ts = texel * mmTile * ( 1 << l );
		const i0 = Math.floor( ( x0 - origin ) / ts ), i1 = Math.floor( ( x1 - origin ) / ts );
		const j0 = Math.floor( ( z0 - origin ) / ts ), j1 = Math.floor( ( z1 - origin ) / ts );
		let mn = Infinity, mx = - Infinity;
		let outside = false;
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			if ( i < 0 || j < 0 || i >= L.n || j >= L.n ) {

				outside = true;
				continue;

			}

			const k = j * L.n + i;
			if ( L.min[ k ] < mn ) mn = L.min[ k ];
			if ( L.max[ k ] > mx ) mx = L.max[ k ];

		}

		if ( outside ) {

			mn = Math.min( mn, - 90 );
			mx = Math.max( mx, - 90 );

		}

		return [ mn - 1, mx + 2 ];

	}

	// ------------------------------------------------------------ spawn

	// Find a beach on the given island grid: a dry point just above the
	// waterline with genuinely deep water a short swim out (for the boat).
	// Prefers shores facing +z (the swell side, where tidewater's breakers
	// rig) and points near the island centre. Returns island-LOCAL coords:
	// { beach: {x, z, yaw}, boat: {x, z, heading} } or null.
	// ------------------------------------------------------------ inland water (lakes / rivers / swamps)
	// Per window texel weights of the three freshwater bodies, from kn's body codes (2 lake,
	// 3 river, 4 tributary channel, 5 swamp, 6 estuary = river meeting the sea, half weight) plus
	// waterlogged swamp ground. Dilated 2 texels (narrow channels keep full weight) and box-blurred
	// 3 texels twice, so the water shader blends calm and colour smoothly across banks and mouths.
	buildInland() {

		const res = this.res, n = res * res;
		const lake = new Float32Array( n ), river = new Float32Array( n ), swamp = new Float32Array( n );
		const B = this.fBody, S = this.fSwamp, H = this.heights;
		for ( let k = 0; k < n; k ++ ) {

			const b = B[ k ];
			if ( b === 2 ) lake[ k ] = 1;
			else if ( b === 3 || b === 4 ) river[ k ] = 1;
			else if ( b === 6 ) river[ k ] = 0.55;
			else if ( b === 5 ) swamp[ k ] = 1;
			else if ( b === 0 && S[ k ] > 0.45 && H[ k ] < 0.25 ) swamp[ k ] = Math.min( 1, S[ k ] * 1.2 );

		}
		const tmp = new Float32Array( n );
		for ( const f of [ lake, river, swamp ] ) {

			dilateField( f, tmp, res, 2 );
			blurField( f, tmp, res, 3 );
			blurField( f, tmp, res, 3 );

		}
		this.inland = { lake, river, swamp };

	}

	// RGBA32F texels for TerrainGPU's height texture: height, lake, river, swamp
	packedHeights() {

		if ( ! this.inland ) this.buildInland();
		const n = this.res * this.res, out = new Float32Array( n * 4 );
		const H = this.heights, { lake, river, swamp } = this.inland;
		for ( let k = 0; k < n; k ++ ) {

			const o = k * 4;
			out[ o ] = H[ k ]; out[ o + 1 ] = lake[ k ]; out[ o + 2 ] = river[ k ]; out[ o + 3 ] = swamp[ k ];

		}
		return out;

	}

	// window texel index of a local position (-1 outside the window)
	texelIndex( x, z ) {

		const i = Math.floor( ( x - this.origin ) / this.texel ), j = Math.floor( ( z - this.origin ) / this.texel );
		if ( i < 0 || j < 0 || i >= this.res || j >= this.res ) return - 1;
		return j * this.res + i;

	}

	// water at a local position: { body: 'sea'|'lake'|'river'|'swamp'|'land', depth (m below sea level), w: weights }
	waterAt( x, z ) {

		const k = this.texelIndex( x, z );
		const depth = - this.heightAt( x, z );
		if ( k < 0 ) return { body: 'sea', depth, lake: 0, river: 0, swamp: 0 };
		const lake = this.inland ? this.inland.lake[ k ] : 0, river = this.inland ? this.inland.river[ k ] : 0, swamp = this.inland ? this.inland.swamp[ k ] : 0;
		let body = depth > 0 ? 'sea' : 'land';
		const top = Math.max( lake, river, swamp );
		if ( top > 0.35 ) body = top === lake ? 'lake' : top === river ? 'river' : 'swamp';
		if ( depth <= 0.05 ) body = 'land'; // banks under the dilated weights are dry land
		return { body, depth, lake, river, swamp };

	}

	// river flow direction (unit xz, or null) at a local position, from kn's flow field
	flowAt( x, z ) {

		const vx = x + this.offsetX, vz = z + this.offsetZ;
		const desc = this.descriptorAt( vx, vz );
		const grid = desc && this.gridFor( desc );
		if ( ! grid || ! grid.flowX || ! grid.flowZ ) return null;
		const lx = vx - desc.cx, lz = vz - desc.cz;
		const fx = sampleIslandField( grid, grid.flowX, lx, lz ), fz = sampleIslandField( grid, grid.flowZ, lx, lz );
		const l = Math.hypot( fx, fz );
		return l > 1e-5 ? { x: fx / l, z: fz / l } : null;

	}

	findSpawn( desc ) {

		const grid = this.gridFor( desc );
		if ( ! grid ) return null;
		const { N, cell, half, heights } = grid;
		const H = ( lx, lz ) => sampleIslandGrid( grid, lx, lz );
		let best = null;
		const step = cell * 6;
		for ( let lz = - half + step; lz < half - step; lz += step ) {

			for ( let lx = - half + step; lx < half - step; lx += step ) {

				const h = H( lx, lz );
				if ( h < 0.35 || h > 1.6 ) continue;
				// seaward = downhill direction
				const gx = ( H( lx + 12, lz ) - H( lx - 12, lz ) ) / 24;
				const gz = ( H( lx, lz + 12 ) - H( lx, lz - 12 ) ) / 24;
				const gl = Math.hypot( gx, gz );
				if ( gl < 0.02 ) continue;
				const sx = - gx / gl, sz = - gz / gl; // unit, toward the sea
				const deep = H( lx + sx * 130, lz + sz * 130 );
				if ( deep > - 3.2 ) continue;
				const inland = H( lx - sx * 45, lz - sz * 45 );
				if ( inland < 1.2 ) continue;
				const distC = Math.hypot( lx, lz );
				let score = distC * 0.01 + Math.abs( h - 0.8 );
				if ( sz > 0.45 ) score -= 60; // swell-facing shore: breakers + open sea ahead
				if ( ! best || score < best.score ) best = { score, lx, lz, sx, sz };

			}

		}
		if ( ! best ) return null;
		// walk out to the boat spot: first point at least 4.5 m deep; on a
		// gently shelving beach (no such point) take the deepest spot found
		// instead of a blind fallback distance
		let bd = 60, deepest = Infinity;
		for ( let d = 40; d <= 320; d += 10 ) {

			const hd = H( best.lx + best.sx * d, best.lz + best.sz * d );
			if ( hd < deepest ) { deepest = hd; bd = d; }
			if ( hd < - 4.5 ) break;

		}
		const yaw = Math.atan2( - best.sx, - best.sz ); // Player yaw convention: forward = (-sin yaw, -cos yaw)
		return {
			beach: { x: best.lx, z: best.lz, yaw },
			boat: { x: best.lx + best.sx * bd, z: best.lz + best.sz * bd, heading: Math.atan2( best.sx, best.sz ) }, // boat frame: bow is +Z, rotated by heading
			seaward: { x: best.sx, z: best.sz },
		};

	}

}

// ---------------------------------------------------------------- inland field filters
// max filter of radius r (separable), in place; tmp is scratch of the same size
function dilateField( f, tmp, res, r ) {

	for ( let j = 0; j < res; j ++ ) {

		const o = j * res;
		for ( let i = 0; i < res; i ++ ) {

			let m = 0;
			const a = Math.max( 0, i - r ), b = Math.min( res - 1, i + r );
			for ( let x = a; x <= b; x ++ ) { const v = f[ o + x ]; if ( v > m ) m = v; }
			tmp[ o + i ] = m;

		}

	}
	for ( let i = 0; i < res; i ++ ) {

		for ( let j = 0; j < res; j ++ ) {

			let m = 0;
			const a = Math.max( 0, j - r ), b = Math.min( res - 1, j + r );
			for ( let y = a; y <= b; y ++ ) { const v = tmp[ y * res + i ]; if ( v > m ) m = v; }
			f[ j * res + i ] = m;

		}

	}

}

// box blur of radius r (separable running sums, clamped edges), in place
function blurField( f, tmp, res, r ) {

	const w = 2 * r + 1;
	for ( let j = 0; j < res; j ++ ) {

		const o = j * res;
		let s = 0;
		for ( let x = - r; x <= r; x ++ ) s += f[ o + Math.min( res - 1, Math.max( 0, x ) ) ];
		for ( let i = 0; i < res; i ++ ) {

			tmp[ o + i ] = s / w;
			s += f[ o + Math.min( res - 1, i + r + 1 ) ] - f[ o + Math.max( 0, i - r ) ];

		}

	}
	for ( let i = 0; i < res; i ++ ) {

		let s = 0;
		for ( let y = - r; y <= r; y ++ ) s += tmp[ Math.min( res - 1, Math.max( 0, y ) ) * res + i ];
		for ( let j = 0; j < res; j ++ ) {

			f[ j * res + i ] = s / w;
			s += tmp[ Math.min( res - 1, j + r + 1 ) * res + i ] - tmp[ Math.max( 0, j - r ) * res + i ];

		}

	}

}
