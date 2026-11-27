import { ShaderModule, UniformBlock } from '../engine/gpu/Shader.js';
import { ComputeKernel } from '../engine/gpu/Compute.js';
import { Texture } from '../engine/gpu/Texture.js';
import { generateMipmaps } from '../engine/gpu/Mipmaps.js';
import { GPU } from '../engine/gpu/GPU.js';
import { FrameUniforms, G } from '../engine/render/Frame.js';
import { commonModule } from '../engine/render/wgsl/common.js';
import { Vector2, Vector3, MathUtils } from '../engine/math/index.js';

// Volumetric trade-wind cumulus (Schneider/Nubis density model, Hillaire multiple-scattering
// approximation) under a thin cirrus veil.
//   - view: ray marched in screen space, one pixel of every 4x4 block per frame (two while the camera
//     turns), accumulated at 0.6x the render resolution with reprojection (camera motion and wind drift)
//     and upsampled bicubically, like sky-pro-webgpu's High quality (about 1/44 of the display pixels
//     marched per frame). Empty space is skipped with a coverage dependent 3D distance field, so rays
//     only take small (24 m) steps near clouds.
//   - panorama: a cheaper low resolution version of the whole sky dome for water reflections,
//     the environment cube and Snell's window, refreshed progressively (1/32 per frame).
//   - shadow: transmittance of the cloud layer along the sun around the camera (1/4 per frame).
// Detail (after the user's sky-pro-webgpu renderer): a 3 octave worley erosion volume filtered by the pixel
// footprint (plus a finer fetch at close range), erosion growing with height in the cloud (flat bases,
// cauliflower tops, wispy undersides) and a short detailed light tap that shades the billows. Lighting also
// follows sky-pro: three scattering orders from one exponential with a droplet phase, skylight occlusion
// from two upward probes, darker bases.
// Everything outputs vec4( in-scattered radiance, transmittance ): sky * a + rgb composites it.
//
// WGSL module (`clouds.module`, prefix `clouds`):
//   uniform var cloudsParams: CloudsParams
//   fn cloudsSample( dir: vec3f ) -> vec4f       panorama (reflections, environment, Snell's window)
//   fn cloudsSampleView( dir: vec3f ) -> vec4f   full resolution view clouds (main background), panorama outside
//   fn cloudsShadow( xz: vec2f ) -> f32          cloud shadow transmittance at a world position (1 = clear)
// `clouds.shadowModule`: cloudsShadow alone (one texture: for lighting hooks / materials that only need it)
// Port notes: three updated the uniforms before each compute call, so the several traces of one frame
// (camera cut rebuild, turning camera) saw their own slot / previous camera. A WebGPU buffer holds one
// value per submit, so each trace of a frame has its own `CloudsTrace` block and kernel set.

const PI = Math.PI;
const EARTH_R = 6360000;
const TILE = 32768; // m, period of the whole cloud field (every noise tiles within it)
const WEATHER_RES = 512;
const SDF_RES = 256, SDF_H = 16; // distance field cells (horizontal over the tile, vertical over the layer)
const SDF_R = 24; // cells searched horizontally
const SHAPE_RES = 128, SHAPE_SIZE = 2048;
const SHEAR = 0.12; // horizontal lean of the clouds per metre of height (downwind)
const EDGE = 15; // density ramp of the raw shape value (softness of the cloud surface: crisp, the detail erosion shapes it)
const ISLAND_NEAR = 2500, ISLAND_FAR = 9000; // m: big clusters only a little away from the island
// broad, rounded billows: the coarsest erosion lumps are ~190 m (the fine octaves are kept light,
// they only read as grain on the lit surfaces)
const DETAIL_RES = 64, DETAIL_SIZE = 1000;
// detail erosion (after sky-pro-webgpu / Nubis): three worley fbm octaves per fetch (r: 4 - 16, g: 8 - 32,
// b: 16 - 64 cells per period). An octave fades to the mean once its features shrink under ~2 px (a mip
// filter without mips); `crease` is 0 on a lump, 1 between lumps
const D_MEAN = 0.48;
const D_S1 = DETAIL_SIZE / 4, D_NEAR = 3.7, D_S2 = D_S1 / D_NEAR; // m: coarsest features of the two fetches
const PANO_W = 1024, PANO_H = 320;
// cirrus veil: coverage varying over hundreds of km, fibres (flow line streaks, mipmapped)
const SYN_RES = 256, SYN_SIZE = 409600; // m
const FIB_RES = 1024, FIB_TILE = 40000; // m
const SHADOW_RES = 256;
const AP_DIST = 30000; // m, aerial perspective scale toward the horizon
const MS_GAIN = 2.6; // energy of the diffusion (multiply scattered) sunlight term

// 4x4 ordered-dither sequence: one pixel of every block per frame
const ORDER = [ 0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12 ];
const REBUILD_SLOTS = 4; // slots traced per frame right after a camera cut (sharp again after 16 / 4 frames)
// history resolution relative to the (dynamic) render resolution: like sky-pro-webgpu's High quality (0.5),
// the clouds are reconstructed at reduced width and height and one pixel of every 4x4 block is marched per
// frame; the saved rays buy finer steps and fuller lighting
const HISTORY_SCALE = 0.75;

const f = ( x ) => {

	const s = String( x );
	return s.includes( '.' ) || s.includes( 'e' ) ? s : s + '.0';

};

// ------------------------------------------------------------ WGSL: noise generation helpers

const NOISE_WGSL = /* wgsl */`
fn clMod( x: f32, y: f32 ) -> f32 { return x - y * floor( x / y ); }
fn clMod2( x: vec2f, y: vec2f ) -> vec2f { return x - y * floor( x / y ); }
fn clMod3( x: vec3f, y: f32 ) -> vec3f { return x - y * floor( x / y ); }
fn clHash3( p: vec3f ) -> f32 { return fract( sin( dot( p, vec3f( 127.1, 311.7, 74.7 ) ) ) * 43758.5453 ); }
fn clHash2( p: vec2f ) -> f32 { return fract( sin( dot( p, vec2f( 127.1, 311.7 ) ) ) * 43758.5453 ); }

// tileable 3D worley (F1) with cells cells per unit
fn clWorley3( p: vec3f, cells: f32 ) -> f32 {
	let q = p * cells;
	let ip = floor( q );
	let fp = fract( q );
	var d = 1e3;
	for ( var z = -1; z <= 1; z++ ) { for ( var y = -1; y <= 1; y++ ) { for ( var x = -1; x <= 1; x++ ) {
		let o = vec3f( f32( x ), f32( y ), f32( z ) );
		let cell = clMod3( ip + o, cells );
		let h = vec3f( clHash3( cell ), clHash3( cell + 19.7 ), clHash3( cell + 41.3 ) );
		d = min( d, length( o + h - fp ) );
	} } }
	return d;
}

// tileable 3D gradient (perlin) noise, about -1..1
fn clGrad3( i: vec3f, f: vec3f, o: vec3f, cells: f32 ) -> f32 {
	let c = clMod3( i + o, cells );
	let gv = vec3f( clHash3( c ), clHash3( c + 13.1 ), clHash3( c + 27.7 ) ) * 2.0 - 1.0;
	return dot( gv, f - o );
}
fn clGnoise( p: vec3f, cells: f32 ) -> f32 {
	let q = p * cells;
	let i = floor( q );
	let f = fract( q );
	let u = f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 ); // (sic: the original's fade, f^2 not f^3)
	let x00 = mix( clGrad3( i, f, vec3f( 0.0, 0.0, 0.0 ), cells ), clGrad3( i, f, vec3f( 1.0, 0.0, 0.0 ), cells ), u.x );
	let x10 = mix( clGrad3( i, f, vec3f( 0.0, 1.0, 0.0 ), cells ), clGrad3( i, f, vec3f( 1.0, 1.0, 0.0 ), cells ), u.x );
	let x01 = mix( clGrad3( i, f, vec3f( 0.0, 0.0, 1.0 ), cells ), clGrad3( i, f, vec3f( 1.0, 0.0, 1.0 ), cells ), u.x );
	let x11 = mix( clGrad3( i, f, vec3f( 0.0, 1.0, 1.0 ), cells ), clGrad3( i, f, vec3f( 1.0, 1.0, 1.0 ), cells ), u.x );
	return mix( mix( x00, x10, u.y ), mix( x01, x11, u.y ), u.z );
}

// billows: inverted worley fbm (1 at the feature points)
fn clBillows( p: vec3f, c: f32 ) -> f32 { return 1.0 - ( clWorley3( p, c ) * 0.625 + clWorley3( p, c * 2.0 ) * 0.25 + clWorley3( p, c * 4.0 ) * 0.125 ); }
fn clPerlinFbm( p: vec3f, c: f32 ) -> f32 { return clGnoise( p, c ) * 0.5 + clGnoise( p, c * 2.0 ) * 0.25 + clGnoise( p, c * 4.0 ) * 0.125; }

fn clVh( i: vec2f, o: vec2f, cells: vec2f ) -> f32 { return clHash2( clMod2( i + o, cells ) ); }
fn clVnoise2( p: vec2f, cells: vec2f ) -> f32 {
	let q = p * cells;
	let i = floor( q );
	let f = fract( q );
	let u = f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 ); // (sic: the original's fade, f^2 not f^3)
	return mix( mix( clVh( i, vec2f( 0.0, 0.0 ), cells ), clVh( i, vec2f( 1.0, 0.0 ), cells ), u.x ),
		mix( clVh( i, vec2f( 0.0, 1.0 ), cells ), clVh( i, vec2f( 1.0, 1.0 ), cells ), u.x ), u.y );
}

fn clGh( i: vec2f, f: vec2f, o: vec2f, cells: vec2f ) -> f32 {
	let c = clMod2( i + o, cells );
	let a = clHash2( c ) * ${ f( 2 * PI ) };
	return dot( vec2f( cos( a ), sin( a ) ), f - o );
}
fn clGnoise2( p: vec2f, cells: vec2f ) -> f32 {
	let q = p * cells;
	let i = floor( q );
	let f = fract( q );
	let u = f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 ); // (sic: the original's fade, f^2 not f^3)
	return mix( mix( clGh( i, f, vec2f( 0.0, 0.0 ), cells ), clGh( i, f, vec2f( 1.0, 0.0 ), cells ), u.x ),
		mix( clGh( i, f, vec2f( 0.0, 1.0 ), cells ), clGh( i, f, vec2f( 1.0, 1.0 ), cells ), u.x ), u.y );
}
// gradient noise fbm remapped to about 0..1 (smoother than value noise, no grid artefacts)
fn clGfbm( p: vec2f, cells: vec2f, seed: f32 ) -> f32 {
	return ( clGnoise2( p + seed, cells ) * 0.55 + clGnoise2( p + seed * 1.7, cells * 2.0 ) * 0.3 + clGnoise2( p + seed * 2.3, cells * 4.0 ) * 0.15 ) * 1.6 + 0.5;
}
`;

// ------------------------------------------------------------ WGSL: shared cloud helpers (constants + small functions)

function helpersWGSL( rot ) {

	const c = Math.cos( rot ), s = Math.sin( rot );
	const ha = rot + 0.6;
	return /* wgsl */`
const CL_EARTH_R: f32 = ${ f( EARTH_R ) };
const CL_TILE: f32 = ${ f( TILE ) };
const CL_D_MEAN: f32 = ${ f( D_MEAN ) };
const CL_EDGE: f32 = ${ f( EDGE ) };
const CL_AP_DIST: f32 = ${ f( AP_DIST ) };
const CL_MS: f32 = ${ f( MS_GAIN ) };
// weather map lookups are rotated so cloud streets line up with the (initial) wind
const CL_C: f32 = ${ f( c ) };
const CL_S: f32 = ${ f( s ) };
// frame of the upper wind (veered from the trades)
const CL_HC: f32 = ${ f( Math.cos( ha ) ) };
const CL_HS: f32 = ${ f( Math.sin( ha ) ) };

// top of a cloud column (fraction of the layer) from the cell profile (0..1), the cell's top and
// the turret noise: broad rounded domes, uneven
fn clSmallTop( cs: f32, top: f32, lump: f32 ) -> f32 { return top * pow( cs, 0.42 ) * ( lump * 0.8 + 0.65 ); }
fn clBigTop( cb: f32, lump: f32 ) -> f32 { return pow( cb, 0.6 ) * ( lump * 0.35 + 0.7 ); }
fn clCreaseOf( x: f32 ) -> f32 { return smoothstep( 0.42, 0.64, x ); }
// erosion grows with the height in the cloud: flat, dense bases, billowy tops; the undersides use the
// inverted field (wisps instead of lumps)
fn clErosionAmount( b: vec4f ) -> f32 { return mix( 0.25, 1.0, smoothstep( 0.05, 0.6, b.y ) ); }
fn clErosionField( F: f32, b: vec4f ) -> f32 { return mix( 1.0 - F, F, smoothstep( 0.0, 0.08, b.y ) ); }
// erosion only eats the outer shell of the base shape (Nubis remap): the dense core keeps no holes
fn clEroded( b: vec4f, crease: f32 ) -> f32 { return sat( ( b.x - crease * clErosionAmount( b ) * sat( 1.0 - b.x * 0.9 ) - 0.012 ) * CL_EDGE ); }
// density with every detail octave at its mean (reflections, shadows, deep light samples): the same
// cloud as the detailed one, seen through a coarse filter
fn clMeanCrease( b: vec4f ) -> f32 { return clCreaseOf( clErosionField( CL_D_MEAN, b ) ); }
fn clMeanDensity( b: vec4f ) -> f32 { return clEroded( b, clMeanCrease( b ) ); }
// layer a (in-scattered radiance, transmittance) in front of layer b
fn clOver( a: vec4f, b: vec4f ) -> vec4f { return vec4f( a.rgb + b.rgb * a.a, a.a * b.a ); }
// Henyey-Greenstein phase
fn clPhaseHG( c: f32, g: f32 ) -> f32 { return ( ( 1.0 - g * g ) / ( 4.0 * PI ) ) / pow( max( 1.0 + g * g - c * 2.0 * g, 1e-4 ), 1.5 ); }

// distance along rd from a point at height camY (on the planet axis) to the sphere at altitude H
// (camera below it). Stable form: |oc|^2 - R^2 = (camY - H)(2Re + camY + H)
fn cloudsShell( camY: f32, rd: vec3f, H: f32 ) -> f32 {
	let b = rd.y * ( camY + CL_EARTH_R );
	let cc = ( camY - H ) * ( camY + H + 2.0 * CL_EARTH_R );
	let disc = b * b - cc;
	return - b + sqrt( max( disc, 0.0 ) );
}

// camera frame projection: direction -> uv (y down) of a camera given by its basis and frustum tangents
fn cloudsProject( d: vec3f, right: vec3f, up: vec3f, fwd: vec3f, tanv: vec2f ) -> vec2f {
	let z = max( dot( d, fwd ), 1e-4 );
	let ndc = vec2f( dot( d, right ), dot( d, up ) ) / ( tanv * z );
	return vec2f( ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5 );
}
`;

}

// bicubic Catmull-Rom in 5 bilinear taps (corners dropped), for texture `tex` (sampled with smpLinearClamp)
function catmullRomWGSL( name, tex ) {

	return /* wgsl */`
fn ${ name }( uv: vec2f, size: vec2f ) -> vec4f {
	let sp = uv * size;
	let tp1 = floor( sp - 0.5 ) + 0.5;
	let f = sp - tp1;
	let w0 = f * ( f * ( f * -0.5 + 1.0 ) - 0.5 );
	let w1 = f * f * ( f * 1.5 - 2.5 ) + 1.0;
	let w2 = f * ( f * ( f * -1.5 + 2.0 ) + 0.5 );
	let w3 = f * f * ( f * 0.5 - 0.5 );
	let w12 = w1 + w2;
	let tc0 = ( tp1 - 1.0 ) / size;
	let tc3 = ( tp1 + 2.0 ) / size;
	let tc12 = ( tp1 + w2 / w12 ) / size;
	let a = w12.x * w0.y; let b = w0.x * w12.y; let cc = w12.x * w12.y; let d = w3.x * w12.y; let e = w12.x * w3.y;
	let sum = textureSampleLevel( ${ tex }, smpLinearClamp, vec2f( tc12.x, tc0.y ), 0.0 ) * a
		+ textureSampleLevel( ${ tex }, smpLinearClamp, vec2f( tc0.x, tc12.y ), 0.0 ) * b
		+ textureSampleLevel( ${ tex }, smpLinearClamp, vec2f( tc12.x, tc12.y ), 0.0 ) * cc
		+ textureSampleLevel( ${ tex }, smpLinearClamp, vec2f( tc3.x, tc12.y ), 0.0 ) * d
		+ textureSampleLevel( ${ tex }, smpLinearClamp, vec2f( tc12.x, tc3.y ), 0.0 ) * e;
	return sum / ( a + b + cc + d + e );
}
`;

}

export class Clouds {

	constructor( renderer, atmosphere ) {

		this.renderer = renderer;
		this.atmosphere = atmosphere;

		const wind0 = new Vector2().copy( G.windDir.value ).normalize().multiplyScalar( 12 );
		this.params = new UniformBlock( 'CloudsParams', {
			coverage: [ 'f32', 0.45 ],
			densityScale: [ 'f32', 0.07 ], // extinction (1/m) of the densest cloud
			bottom: [ 'f32', 750 ],
			top: [ 'f32', 2400 ],
			// m/s; clouds drift along it (by default with the surface wind, as trade winds do)
			wind: [ 'vec2f', wind0 ],
			offset: [ 'vec2f', new Vector2() ], // accumulated wind offset (m)
			shadowCenter: [ 'vec2f', new Vector2() ],
			shadowSize: [ 'f32', 8000 ],
			shadowStrength: [ 'f32', 0.85 ],
			// cirrus veil: amount 0..1 (0.5: faint, opacity mostly 0.05 - 0.2) and altitude (m)
			cirrus: [ 'f32', 0.5 ],
			cirrusAlt: [ 'f32', 9000 ],
			// per frame state (camera relative: the camera sits on the planet axis)
			camY: [ 'f32', 1 ],
			horizonY: [ 'f32', - 0.001 ], // rays below hit the planet
			nOrigin: [ 'vec2f', new Vector2() ], // noise space origin
			wOrigin: [ 'vec2f', new Vector2() ], // weather space origin
			camXZ: [ 'vec2f', new Vector2() ],
			hOffset: [ 'vec2f', new Vector2() ], // cirrus drift (faster upper wind)
			windN: [ 'vec2f', new Vector2( 1, 0 ) ], // wind direction (shear lean)
			viewSize: [ 'vec2f', new Vector2( 4, 4 ) ],
			traceSize: [ 'vec2f', new Vector2( 1, 1 ) ],
			displayH: [ 'f32', 4 ], // render height (px): filters the noise
			viewValid: [ 'f32', 0 ],
			sdfCoverage: [ 'f32', 0 ],
			shadowPhase: [ 'f32', 0 ],
			panoSlot: [ 'vec2f', new Vector2() ],
			// camera basis (unit vectors) and frustum tangents
			camRight: [ 'vec3f', new Vector3( 1, 0, 0 ) ],
			camUp: [ 'vec3f', new Vector3( 0, 1, 0 ) ],
			camFwd: [ 'vec3f', new Vector3( 0, 0, - 1 ) ],
			camTan: [ 'vec2f', new Vector2( 1, 1 ) ],
			// camera the view texture was last traced with
			viewRight: [ 'vec3f', new Vector3( 1, 0, 0 ) ],
			viewUp: [ 'vec3f', new Vector3( 0, 1, 0 ) ],
			viewFwd: [ 'vec3f', new Vector3( 0, 0, - 1 ) ],
			viewTan: [ 'vec2f', new Vector2( 1, 1 ) ],
		}, { label: 'clouds' } );
		const U = this.params.fields;
		// three-style handles (same names as the TSL version)
		this.coverage = U.coverage;
		this.densityScale = U.densityScale;
		this.bottom = U.bottom;
		this.top = U.top;
		this.wind = U.wind;
		this.offset = U.offset;
		this.shadowCenter = U.shadowCenter;
		this.shadowSize = U.shadowSize;
		this.shadowStrength = U.shadowStrength;
		this.cirrus = U.cirrus;
		this.cirrusAlt = U.cirrusAlt;
		this.camY = U.camY;
		this.nOrigin = U.nOrigin;
		this.wOrigin = U.wOrigin;
		this.camXZ = U.camXZ;
		this.hOffset = U.hOffset;
		this.horizonY = U.horizonY;
		this.windN = U.windN;
		this.viewSize = U.viewSize;
		this.displayH = U.displayH;
		this.traceSize = U.traceSize;
		this.viewValid = U.viewValid;
		this.sdfCoverage = U.sdfCoverage;
		this.shadowPhase = U.shadowPhase;
		this.panoSlot = U.panoSlot;
		this.cam = { right: U.camRight, up: U.camUp, fwd: U.camFwd, tan: U.camTan };
		this.viewCam = { right: U.viewRight, up: U.viewUp, fwd: U.viewFwd, tan: U.viewTan };
		// previous frame's camera (CPU side; each trace gets a copy in its own block)
		this.prev = { right: { value: new Vector3( 1, 0, 0 ) }, up: { value: new Vector3( 0, 1, 0 ) }, fwd: { value: new Vector3( 0, 0, - 1 ) }, tan: { value: new Vector2( 1, 1 ) } };
		this.camDelta = { value: new Vector3() }; // camera motion minus wind drift
		this.camDeltaHi = { value: new Vector3() }; // same for the high layers
		this.historyValid = { value: 0 };
		// weight of a new sample for static pixels: a running average right after a cut, then an
		// exponential one over about 16 samples
		this.minAlpha = { value: 0.12 };
		this.rebuildK = { value: - 1 }; // >= 0: rebuilding after a camera cut (slots traced so far)
		this.slot = { value: new Vector2() };
		this.subPixel = { value: new Vector2() }; // ray offset in the traced pixel
		this.frameNoise = { value: 0 };

		// weather map lookups are rotated so cloud streets line up with the (initial) wind
		const w = this.wind.value;
		this._rot = Math.atan2( w.y, w.x );
		this._offsetW = new Vector2();
		this._offsetH = new Vector2();

		this._makeNoise();
		this._makeTargets();
		this._buildModules();
		this._buildKernels();
		this._generateNoise();

		this.frame = 0;
		this.panoWarm = 1;
		// resolution of the view clouds relative to the drawing buffer (e.g. follow a dynamic
		// resolution scale); the sky is reconstructed per pixel from direction, so any size works
		this.resolutionScale = 1;
		// output (drawing buffer) size override; default: renderer.getDrawingBufferSize, the canvas or frame.outputResolution
		this.outputSize = null;
		this._prevCam = new Vector3();
		this._prevSun = new Vector3();
		this._hasPrev = false;
		this._rebuild = 0; // slots traced since the last camera cut (16: done)
		this._since = 0; // frames since the rebuild completed
		this._traces = 0;
		this._pp = 0; // history ping-pong
		this._traceIndex = 0; // traces recorded this frame (each needs its own uniform block)

	}

	// ------------------------------------------------------------ noise volumes

	_makeNoise() {

		const make3D = ( size, name ) => new Texture( { label: name, width: size, height: size, depth: size, dimension: '3d', format: 'rgba8unorm', usage: [ 'sample', 'storage' ] } );
		this.shapeTex = make3D( SHAPE_RES, 'cloudShape' );
		this.detailTex = make3D( DETAIL_RES, 'cloudDetail' );
		// r = small cell profile, g = its top (fraction of the layer), b = turrets, a = big cell profile
		this.weatherTex = new Texture( { label: 'cloudWeather', width: WEATHER_RES, height: WEATHER_RES, format: 'rgba8unorm', usage: [ 'sample', 'storage' ] } );
		// r = cirrus coverage (hundreds of km), g = broad streets along the upper wind, b = patches (5 - 50 km)
		this.synTex = new Texture( { label: 'cloudSynoptic', width: SYN_RES, height: SYN_RES, format: 'rgba8unorm', usage: [ 'sample', 'storage' ] } );
		// cirrus: r = fibres, g = veil noise (mipmapped: the fibres are filtered by the pixel footprint)
		this.fibTex = new Texture( { label: 'cloudFibres', width: FIB_RES, height: FIB_RES, format: 'rgba8unorm', mips: true, usage: [ 'sample', 'storage', 'render' ] } );
		// fibre seeds and flow direction (r = seeds, g = flow angle)
		this.auxTex = new Texture( { label: 'cloudFibreFlow', width: FIB_RES, height: FIB_RES, format: 'rgba16float', usage: [ 'sample', 'storage' ] } );

	}

	_generateNoise() {

		const k = this._noiseKernels;
		k.syn.dispatch( [ SYN_RES / 8, SYN_RES / 8, 1 ] );
		k.aux.dispatch( [ FIB_RES / 8, FIB_RES / 8, 1 ] );
		k.fib.dispatch( [ FIB_RES / 8, FIB_RES / 8, 1 ] );
		generateMipmaps( this.fibTex );
		k.shape.dispatch( [ SHAPE_RES / 4, SHAPE_RES / 4, SHAPE_RES / 4 ] );
		k.detail.dispatch( [ DETAIL_RES / 4, DETAIL_RES / 4, DETAIL_RES / 4 ] );
		k.weather.dispatch( [ WEATHER_RES / 8, WEATHER_RES / 8, 1 ] );

	}

	_makeTargets() {

		const make = ( w, h, name ) => new Texture( { label: name, width: w, height: h, format: 'rgba16float', usage: [ 'sample', 'storage', 'copySrc' ] } );
		this.panorama = make( PANO_W, PANO_H, 'cloudPanorama' );
		// read with textureLoad (manual bilinear): materials need no sampler for it
		this.shadowMap = make( SHADOW_RES, SHADOW_RES, 'cloudShadow' );
		// 3D distance field (in cells) to anything that may hold cloud; ping-pong for the passes
		const make3 = ( name ) => new Texture( { label: name, width: SDF_RES, height: SDF_RES, depth: SDF_H, dimension: '3d', format: 'rgba8unorm', usage: [ 'sample', 'storage' ] } );
		this.sdfA = make3( 'cloudSdfA' );
		this.sdfB = make3( 'cloudSdfB' );
		this.sdfTex = make3( 'cloudSdf' );

		// screen space view buffers (resized with the canvas)
		this.traceTex = make( 1, 1, 'cloudTrace' );
		this.traceDepth = make( 1, 1, 'cloudTraceDepth' );
		this.highTrace = make( 1, 1, 'cloudHighTrace' );
		this.motionTex = make( 1, 1, 'cloudMotion' );
		// range of this frame's samples around each block (neighborhood clamp of the history)
		this.boxMin = make( 1, 1, 'cloudBoxMin' );
		this.boxMax = make( 1, 1, 'cloudBoxMax' );
		this.history = [ make( 4, 4, 'cloudViewA' ), make( 4, 4, 'cloudViewB' ) ];
		this.viewTex = this.history[ 0 ];
		this._w = 0;
		this._h = 0;

	}

	// ------------------------------------------------------------ WGSL modules

	_buildModules() {

		const atmo = this.atmosphere;
		const helpers = new ShaderModule( { name: 'cloudsHelpers', deps: [ commonModule ], code: helpersWGSL( this._rot ) } );
		this.helpersModule = helpers;

		// density, lighting and the marches (kernels only)
		this.coreModule = new ShaderModule( {
			name: 'cloudsCore',
			deps: [ commonModule, atmo.module, helpers ],
			uniforms: this.params,
			uniformName: 'cloudsParams',
			bindings: {
				cloudsWeatherTex: { texture: this.weatherTex },
				cloudsShapeTex: { texture: this.shapeTex },
				cloudsDetailTex: { texture: this.detailTex },
				cloudsSdfTex: { texture: this.sdfTex },
				cloudsSynTex: { texture: this.synTex },
				cloudsFibTex: { texture: this.fibTex },
			},
			code: /* wgsl */`
// weather space (rotated so cloud streets follow the wind) uv of a camera relative position
fn cloudsWeatherUV( pxz: vec2f ) -> vec2f {
	return ( vec2f( pxz.x * CL_C + pxz.y * CL_S, pxz.y * CL_C - pxz.x * CL_S ) + cloudsParams.wOrigin ) / CL_TILE;
}

// x: cell profile (after the coverage control), y: top of this column (fraction of the layer).
// pxz: camera relative; big cells and towers are only allowed far from the island (origin)
fn cloudsWeather( pxz: vec2f ) -> vec2f {
	let w = textureSampleLevel( cloudsWeatherTex, smpLinearRepeat, cloudsWeatherUV( pxz ), 0.0 );
	let thr = 1.0 - cloudsParams.coverage * 1.3;
	let far = smoothstep( ${ f( ISLAND_NEAR ) }, ${ f( ISLAND_FAR ) }, length( pxz + cloudsParams.camXZ ) );
	// cells too weak to hold more than a scrap of cloud are dropped (no scattered specks)
	let cs = sat( ( ( w.x - thr ) / max( 1.0 - thr, 0.05 ) - 0.08 ) * 1.09 );
	let cb = sat( ( ( w.w * far - thr ) / max( 1.0 - thr, 0.05 ) - 0.08 ) * 1.09 );
	return vec2f( max( cs, cb ), max( clSmallTop( cs, w.y, w.z ), clBigTop( cb, w.z ) ) );
}

// distance (m) that is certainly free of cloud around p (0 near clouds). Nearest lookup of the distance
// field: x / y repeat (the field tiles), z clamped to the layer
fn cloudsSkip( p: vec3f ) -> f32 {
	let alt = p.y + ( p.x * p.x + p.z * p.z ) / ${ f( 2 * EARTH_R ) };
	let H = cloudsParams.top - cloudsParams.bottom;
	let uvw = vec3f( fract( cloudsWeatherUV( p.xz ) ), sat( ( alt - cloudsParams.bottom ) / H ) );
	let ix = vec3i( min( vec3f( floor( uvw * vec3f( ${ f( SDF_RES ) }, ${ f( SDF_RES ) }, ${ f( SDF_H ) } ) ) ), vec3f( ${ f( SDF_RES - 1 ) }, ${ f( SDF_RES - 1 ) }, ${ f( SDF_H - 1 ) } ) ) );
	let d = textureLoad( cloudsSdfTex, ix, 0 ).x * 255.0;
	return max( d - 1.0, 0.0 ) * min( H / ${ f( SDF_H ) }, ${ f( TILE / SDF_RES ) } );
}

// base shape. p: camera relative (sheared) position, w: weather
// returns vec4( raw shape value, height inside the cloud 0..1, swirl xy ); density = ramp( x )
fn cloudsBase( p: vec3f, w: vec2f ) -> vec4f {
	let alt = p.y + ( p.x * p.x + p.z * p.z ) / ${ f( 2 * EARTH_R ) };
	let hL = ( alt - cloudsParams.bottom ) / ( cloudsParams.top - cloudsParams.bottom );
	let np = p.xz + cloudsParams.nOrigin;
	let n = textureSampleLevel( cloudsShapeTex, smpLinearRepeat, vec3f( np.x, alt * 1.4, np.y ) / ${ f( SHAPE_SIZE ) }, 0.0 );
	// flat, slightly uneven base, the column's (domed) top, edges from the cell profile (steep,
	// so the shape noise can't break fragments off the rim)
	let hb = n.y * 0.025;
	// columns whose top stays very low hold no cloud: the saddles between overlapping weak cells
	// along a street made long, thin, flat ribbons, and the thin rims of each dome made it a flat
	// pancake. Without them the cells stay separate and their sides rise steeply.
	let Ce = sat( ( w.y - hL ) * 3.5 ) * smoothstep( 0.0, 0.45, w.x ) * smoothstep( hb, hb + 0.012, hL ) * smoothstep( 0.1, 0.2, w.y );
	// the shape noise carves the boundary. x is the raw shape value (density before the ramp,
	// negative outside): the detail erodes it in the same units, and the coarse search uses it
	// to slow down near a cloud
	return vec4f( n.x + Ce - 1.0, sat( hL / max( w.y, 0.05 ) ), n.y, n.z );
}

// three detail octaves per fetch; s: size (m) of the coarsest features
fn cloudsOctaves( uvw: vec3f, s: f32, foot: f32 ) -> f32 {
	let d = textureSampleLevel( cloudsDetailTex, smpLinearRepeat, uvw, 0.0 ).xyz;
	let w = vec3f( smoothstep( s * 0.24, s * 0.09, foot ), smoothstep( s * 0.12, s * 0.045, foot ), smoothstep( s * 0.06, s * 0.0225, foot ) );
	return dot( mix( vec3f( CL_D_MEAN ), d, w ), vec3f( 0.56, 0.32, 0.12 ) );
}

// full density with detail erosion. b: result of cloudsBase, foot: pixel footprint (m) that filters the
// octaves. Returns vec2( density, lump ) (1 on a lump, 0 in a crease: shades the crevices)
fn cloudsErode( p: vec3f, b: vec4f, foot: f32 ) -> vec2f {
	let alt = p.y + ( p.x * p.x + p.z * p.z ) / ${ f( 2 * EARTH_R ) };
	let np = p.xz + cloudsParams.nOrigin;
	// low frequency swirl of the detail lookup
	let sw = ( b.zw - 0.5 ) * ( 0.3 * ( 1.0 - b.y * 0.6 ) );
	let dp = vec3f( np.x, alt, np.y ) / ${ f( DETAIL_SIZE ) } + vec3f( sw.x, 0.0, sw.y ) + vec3f( frame.time * 0.0015, 0.0, 0.0 );
	var f1 = CL_D_MEAN;
	var f2 = CL_D_MEAN;
	if ( foot < ${ f( D_S1 * 0.24 ) } ) {
		f1 = cloudsOctaves( dp, ${ f( D_S1 ) }, foot );
		// close range: a finer fetch (lumps down to ~3 m) keeps near clouds crisp
		if ( foot < ${ f( D_S2 * 0.24 ) } ) {
			f2 = cloudsOctaves( dp * ${ f( D_NEAR ) } + 0.37, ${ f( D_S2 ) }, foot );
		}
	}
	let crease = clCreaseOf( clErosionField( f1 * 0.78 + f2 * 0.22, b ) );
	// the creases are eaten: round lumps (cauliflower) on the upper parts, wisps underneath
	return vec2f( clEroded( b, crease ), 1.0 - crease );
}

// the cloud field leans downwind with height (wind shear)
fn cloudsSheared( p: vec3f ) -> vec3f {
	let lean = max( p.y - cloudsParams.bottom, 0.0 ) * ${ f( SHEAR ) };
	return vec3f( p.x - cloudsParams.windN.x * lean, p.y, p.z - cloudsParams.windN.y * lean );
}

// Key light of the clouds: the sun while it is the app's key light (seen from cloud altitude,
// so it keeps lighting the clouds a little after it has set at sea level), else the moon.
// E: illuminance before the earth shadow.
struct CloudsLight { dir: vec3f, E: vec3f, isMoon: bool };
fn cloudsKeyLight( altKm: f32 ) -> CloudsLight {
	var l: CloudsLight;
	l.isMoon = dot( frame.sunDir, atmosphereParams.sunDir ) < 0.9999;
	let sunE = atmosphereSampleTransmittance( 6360.0 + altKm, frame.sunDir.y ) * atmosphereParams.sunIlluminance;
	l.dir = frame.sunDir;
	l.E = select( sunE, frame.sunColor, l.isMoon );
	return l;
}

// earth shadow on a point at altitude alt (m) and horizontal offset pxz (m) from the camera: the
// light is below its horizon once mu < -sqrt( 2 alt / R ) (the local vertical tilts with distance)
fn cloudsEarthShadow( light: CloudsLight, alt: f32, pxz: vec2f ) -> f32 {
	let mu = light.dir.y + dot( light.dir.xz, pxz ) / CL_EARTH_R;
