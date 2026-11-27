import { Material, ShaderModule, G } from '../engine/webgpu.js';
import { commonModule } from '../engine/render/wgsl/common.js';
import { whaleWaterModule } from './WhaleWater.js';
import { REFRACTION_GUARD } from './RefractionPass.js';

const IOR = 1.333;

// WGSL helpers shared with other water effects (Breakers, spray):
//   fn fresnelDielectric( cosI: f32, eta: f32 ) -> f32   exact unpolarized dielectric Fresnel, cosI > 0, eta = n2/n1
//   fn waterPhaseHG( cosT: f32, g: f32 ) -> f32           Henyey-Greenstein
//   fn viewPositionFromViewZ( uv: vec2f, viewZ: f32 ) -> vec3f   view-space position from screen uv (y down)
//      and (negative) linear view Z; robust to reversed depth
export const waterFresnelModule = new ShaderModule( {
	name: 'waterFresnel',
	deps: [ commonModule ],
	code: /* wgsl */`
fn fresnelDielectric( cosI: f32, eta: f32 ) -> f32 {
	let c = clamp( cosI, 0.0, 1.0 );
	let g2 = eta * eta - 1.0 + c * c;
	let tir = g2 < 0.0;
	let g = sqrt( max( g2, 0.0 ) );
	let a = ( g - c ) / ( g + c );
	let b = ( c * ( g + c ) - 1.0 ) / ( c * ( g - c ) + 1.0 );
	return select( 0.5 * ( a * a ) * ( b * b + 1.0 ), 1.0, tir );
}

fn waterPhaseHG( cosT: f32, g: f32 ) -> f32 {
	let g2 = g * g;
	return ( ( 1.0 - g2 ) / ( 4.0 * PI ) ) / pow( max( 1.0 + g2 - cosT * 2.0 * g, 1e-4 ), 1.5 );
}

fn viewPositionFromViewZ( uv: vec2f, viewZ: f32 ) -> vec3f {
	let ndc = vec2f( uv.x * 2.0 - 1.0, ( 1.0 - uv.y ) * 2.0 - 1.0 );
	let p00 = frame.proj[ 0 ][ 0 ];
	let p11 = frame.proj[ 1 ][ 1 ];
	return vec3f( ndc.x / p00, ndc.y / p11, -1.0 ) * ( - viewZ );
}
`,
} );

// three-compatible helpers: WGSL call expressions
export const fresnelDielectric = ( cosI, eta ) => `fresnelDielectric( ${ cosI }, ${ eta } )`;
export const viewPositionFromViewZ = ( uv, viewZ ) => `viewPositionFromViewZ( ${ uv }, ${ viewZ } )`;

// The sea surface. Custom-shaded (no scene lighting model: the TSL version replaced the lighting
// model with WaterLightingModel, which only collected the sun light and called shade()). Drawn in
// its own pass after the opaques (see SceneRenderer); sceneCopy holds the opaque color + depth for
// refraction and absorption.
//
// The WGSL is built on first use (pipelineKey), so systems attached to the surface after this
// material is created (the wake, surf foam) are part of it, like the lazily built NodeMaterial.
// Outputs: r.color (radiance), camera-only velocity (the grid vertices are placed in the vertex
// shader: previous world position = current, staticVelocity), r.mask = ( seenFromBelow, 1, 0, 1 ).
export class WaterMaterial extends Material {

	constructor( { surface, sky, sceneCopy, sceneDepthHalf = null, refraction = null, reflection = null, hullMask = null, hullMaskActive = null } ) {

		super( {
			name: 'water',
			lit: false,
			side: 'double',
			transparent: false,
			blending: 'none',
			depthWrite: true,
			defines: { IS_WATER: 1 },
			attributes: { nodeData: 'vec4f' },
			varyings: {
				vLagXZ: 'vec2f', vWaveH: 'f32', vSeaDepth: 'f32', vFoam: 'f32', vShoreN: 'vec3f',
				vShoreFoam: 'f32', vSurfMask: 'vec2f',
			},
			uniforms: {
				backscatter: [ 'f32', 0.035 ],
				sss: [ 'f32', 1.0 ],
				refraction: [ 'f32', 0.06 ],
				foamIntensity: [ 'f32', 1.0 ],
				waterRoughness: [ 'f32', 0.035 ],
				reflectionStrength: [ 'f32', 1.0 ],
				ssr: [ 'f32', 1 ], // screen-space reflections on/off
				debugMode: [ 'i32', 0 ],
				hullActive: [ 'f32', 0 ],
			},
		} );
		this.isWaterMaterial = true;
		// shaded here: only the sun shadow of the scene lighting is used (see MeshShader)
		this.lightingHooks = false;
		// (`surface` is the Material's surface snippet here: the WaterSurface is `waterSurface`)
		this.waterSurface = surface;
		this.sky = sky;
		this.reflection = reflection;
		this.clouds = null; // set by the app before the first frame
		this.cheap = false;
		this.cameraWaterHeightNode = null; // optional WGSL f32 expression replacing frame.cameraWaterHeight (may carry `.module`, e.g. query.cameraState().x)

		const U = this.uniforms;
		this.params = {
			absorption: G.waterAbsorption, // frame.waterAbsorption
			scattering: G.waterScattering, // frame.waterScattering
			backscatter: U.backscatter,
			sss: U.sss,
			refraction: U.refraction,
			foamIntensity: U.foamIntensity,
			roughness: U.waterRoughness,
			reflectionStrength: U.reflectionStrength,
			ssr: U.ssr,
		};
		this.debugMode = U.debugMode;

		// opaque scene color/depth copies (made by SceneRenderer right before the water pass)
		this.sceneDepthTexture = sceneCopy.depthTexture;
		this.sceneColorTexture = sceneCopy.texture;
		// the same depth as half float (SceneRenderer.opaqueDepthHalf), optional: the reflection march
		this.sceneDepthHalfTexture = sceneDepthHalf;
		// what lies below the water only (ocean/RefractionPass.js): the refraction source
		this.refraction = refraction;
		// camera distance to the nearest hull-volume surface per pixel (SceneRenderer, 0 = none)
		this.hullMaskTexture = hullMask;
		this.hullMaskActive = hullMaskActive;
		// the renderer's { value } handle drives the uniform directly
		if ( hullMaskActive ) this.uniformBlock.fields.hullActive = hullMaskActive;

		this._built = false;

	}

	// two pipelines: with the hull-mask discard (a hull on screen) and without it. A shader that can
	// discard loses early depth / hidden surface removal on every pixel, so the sea only pays for it
	// while a hull is actually masked (SceneRenderer sets hullMaskActive before the water pass).
	// hullOverride (0 / 1) forces a variant (App.precompile builds both).
	get _hullOn() {

		if ( ! this._hull ) return false;
		if ( this.hullOverride !== undefined && this.hullOverride !== null ) return !! this.hullOverride;
		return this.hullMaskActive.value > 0.5;

	}

	pipelineKey() {

		if ( ! this._built ) this._build();
		return super.pipelineKey() + ( this._hullOn ? '.hull' : '' );

	}

	allDefines() {

		return { ...super.allDefines(), WATER_HULL: this._hullOn ? 1 : 0 };

	}

	_build() {

		this._built = true;
		const S = this.waterSurface;
		const sky = this.sky;
		const T = !! S.terrain;
		const SH = !! S.shore;
		const SIM = !! S.shoreSim;
		const SF = !! S.surfFoam;
		const CL = !! ( this.clouds && this.clouds.module );
		const HULL = !! ( this.hullMaskTexture && this.hullMaskActive );
		const REFL = !! ( this.reflection && this.reflection.module );

		this.modules = [ commonModule, waterFresnelModule, waterHelpersModule, whaleWaterModule, S.module, sky && sky.module, CL && this.clouds.module,
			SIM && S.shoreSim.module, REFL && this.reflection.module, this.cameraWaterHeightNode && this.cameraWaterHeightNode.module ].filter( Boolean );
		this.bindings.waterSceneColor = { texture: this.sceneColorTexture };
		this.bindings.waterSceneDepth = { texture: this.sceneDepthTexture, sampleType: 'unfilterable-float' };
		if ( this.sceneDepthHalfTexture ) this.bindings.waterSceneDepthHalf = { texture: this.sceneDepthHalfTexture };
		this.setDefine( 'WATER_DEPTH_HALF', this.sceneDepthHalfTexture ? 1 : 0 );
		const REFR = !! this.refraction;
		if ( REFR ) {

			this.bindings.waterRefrColor = { texture: this.refraction.texture };
			this.bindings.waterRefrDepth = { texture: this.refraction.depthTexture, sampleType: 'unfilterable-float' };

		}

		this.setDefine( 'WATER_REFRACTION', REFR ? 1 : 0 );
		if ( HULL ) this.bindings.waterHullMask = { texture: this.hullMaskTexture, sampleType: 'unfilterable-float' };
		this._hull = HULL;

		this.vertex = /* wgsl */`
	let r = waterSurfaceVertex( v.nodeData, v.position.xz );
	v.useWorld = true;
	v.worldPos = r.position;
	v.worldNormal = vec3f( 0.0, 1.0, 0.0 );
	o.vLagXZ = r.lagXZ;
	o.vWaveH = r.height;
	o.vSeaDepth = r.depth;
	o.vFoam = r.foam;
	o.vShoreN = r.shoreN;
	o.vShoreFoam = r.shoreFoam;
	o.vSurfMask = r.surfMask;
`;
		this.output = this.cheap ? 'r.color = vec4f( 0.02, 0.05, 0.1, 1.0 ); r.mask = vec4f( 0.0, 1.0, 0.0, 1.0 );' : this._shadeWGSL( { T, SH, SIM, SF, CL, HULL, REFL } );
		this.needsUpdate = true;

	}

	// --------------------------------------------------------------- shading (WGSL output snippet)

	_shadeWGSL( { T, SH, SIM, SF, CL, HULL, REFL } ) {

		const S = this.waterSurface;
		// the ShoreWaves module always provides shoreCrestPath / shoreSurfMedium (WGSL; the TSL-era
		// guards on JS methods of the same names were always false in the port)
		const hasCrest = SH;
		const hasMedium = SH;
		// the ShoreWaves module always provides shoreSwashEdge / shoreSwashClip (WGSL)
		const hasClip = T && SH;
		const camWaterH = this.cameraWaterHeightNode ? String( this.cameraWaterHeightNode ) : 'frame.cameraWaterHeight';

		return /* wgsl */`
	let pos = in.P;
	let screenUV = in.pixel * frame.invResolution;
	let posV = ( frame.view * vec4f( pos, 1.0 ) ).xyz;
	let lagXZ = in.vs.vLagXZ;
	let vDepth = in.vs.vSeaDepth;
	let vHeight = in.vs.vWaveH;
	// footprint of this pixel on the surface (m) — for filtering / roughness (uniform control flow)
	let footprint = max( length( fwidth( lagXZ ) ), 1e-4 );

#if WATER_HULL
	// No sea inside a hull: the surface behind the nearest face of the hull volume is water the hull
	// keeps out (without this it shows through the cockpit sole when the stern squats or the boat heels)
	if ( mat.hullActive > 0.5 && in.front ) {
		let mSize = vec2f( textureDimensions( waterHullMask ) );
		let hullDist = textureLoad( waterHullMask, vec2i( clamp( screenUV, vec2f( 0.0 ), vec2f( 0.9999 ) ) * mSize ), 0 ).x;
		if ( hullDist > 0.01 && length( pos - frame.cameraPos ) > hullDist - 0.02 ) { discard; }
	}
#endif

	let toCam = frame.cameraPos - pos;
	let dist = length( toCam );
	let V = toCam / dist;
	let L = frame.sunDir;
	// the sun light reaching the surface: sun colour x shadow maps (three's direct light), x clouds,
	// x the island's own shadow (heightfield horizon: the shadow map's range is too short to hold it)
	// (5-tap PCF: the waves break up any penumbra detail the contact-hardening filter would add)
	var sunLight = frame.sunColor * sunShadowPCF( pos, vec3f( 0.0, 1.0, 0.0 ), in.pixel );
${ CL ? '	sunLight *= cloudsShadow( pos.xz );' : '' }
${ T ? '	sunLight *= terrainSunShadowAt( pos );' : '' }

	// water film thickness at this pixel and the distance to the swash front (ShoreWaves.swashEdge):
	// the sheet ends exactly on its analytic leading edge, not on the mesh triangles
	let groundH = ${ T ? 'terrainHeightAt( pos.xz )' : '-500.0' };
	var thickness = ${ T ? 'pos.y - groundH' : '10.0' };
	var frontD = 1e3;
	var swTau = 0.0;
	var swRt = 0.0;
${ hasClip ? `	if ( vDepth < 1.0 ) {
		let tRaw = thickness;
		let se = shoreSwashEdge( pos.xz, thickness );
		thickness = se.x; frontD = se.y; swTau = se.z; swRt = se.w;
		// The draining sheet has no rounded front: it thins out over decimetres and breaks up where the
		// sand drains faster. The analytic front runs parallel to the shoreline; kept as a hard, smooth
		// edge (with the uprush's meniscus, rim and contact shadow) it read as a dark line ruled along
		// the beach between the foam and the wet sand.
		let backwash = smoothstep( 0.32, 0.46, swTau );
		if ( backwash > 0.0 && swRt > 0.0 && frontD < 3.0 ) {
			frontD += ( perlin2( pos.xz * 1.1 ) * 0.35 + perlin2( pos.xz * 3.7 + vec2f( 5.3, 1.9 ) ) * 0.15 ) * backwash;
			thickness = min( tRaw, frontD * mix( 0.08, 0.025, backwash ) );
		}
	}` : '' }
	// the foam line riding the swash front, per pixel: a dense bubbly bead right at the edge while
	// the sheet runs up, a thinning lace behind it; weaker in the backwash (it sinks into the sand)
	let uprush = smoothstep( 0.46, 0.32, swTau );
	let bead = smoothstep( -0.01, 0.05, frontD ) * smoothstep( 0.6, 0.12, frontD );
	let trail = smoothstep( -0.01, 0.25, frontD ) * smoothstep( 2.2, 0.3, frontD );
	// patchy along the front (dense bunches and thin stretches), not an even white rope (only where
	// the edge foam below can be non-zero: it is weighted by the run-up and the shallow depth)
	var edgePatch = 1.0;
${ hasClip ? `	if ( swRt > 0.0 && vDepth < 0.4 ) {
		edgePatch = smoothstep( -0.45, 0.55, perlin2( pos.xz * 0.42 ) ) * 0.7 + smoothstep( -0.3, 0.6, perlin2( pos.xz * 1.7 + vec2f( 3.1, 7.7 ) ) ) * 0.3;
	}` : '' }
	let edgeFoam = ( bead * mix( 0.45, 1.1, uprush ) * mix( 0.35, 1.0, edgePatch ) + trail * mix( 0.12, 0.4, uprush ) * edgePatch ) * smoothstep( 0.0, 1.0, swRt ) * smoothstep( 0.4, -0.2, vDepth );
	// the meniscus: the last decimetre of the advancing sheet bends down to the sand
	let lipW = ( 1.0 - smoothstep( 0.0, 0.14, frontD ) ) * uprush;

	let simState = ${ SIM ? 'shoreSimSample( pos.xz )' : 'vec4f( 0.0 )' };
	let surf = waterSurfaceFragment( lagXZ, footprint, vDepth, in.vs.vFoam, in.vs.vShoreN, in.vs.vShoreFoam + edgeFoam, simState.x, simState, in.vs.vSurfMask, pos );
	var foam = surf.foam;
	// the whale's churned white water and flat fluke-print slick (WhaleWater.js)
	let whaleW = whaleWater( pos.xz );
	foam = max( foam, whaleW.x );

	// Which medium is the view ray in before it reaches this fragment? The water surface is a closed
	// interface: a front face (its air side towards the camera) is seen from the air, a back face from
	// the water. For the visible (nearest) fragment this is the medium the ray starts in at the near
	// clip plane, which is exactly how the clip plane slices the water. The winding can't be trusted
	// in folds of the choppy / breaking surface: there, and well above or below the surface, the
	// camera's own medium decides.
	let camH = frame.cameraPos.y - ${ camWaterH };
${ SH ? '	let folded = surf.jacobian < 0.1 || normalize( in.vs.vShoreN ).y < 0.35;' : '	let folded = surf.jacobian < 0.1;' }
	let nearSurface = abs( camH ) < 1.5;
	let viewFromBelow = select( camH < 0.0, ! in.front, nearSurface && ! folded );
	let seenFromBelow = select( 0.0, 1.0, viewFromBelow );
	// shading normal on the viewer's side of the interface. Triangle winding can't be trusted
	// (tiny self-intersections of the choppy FFT surface render as back faces seen from above),
	// so pick the side from the camera and bend facets that face away to grazing instead of
	// flipping them (a flipped normal turns a fold into a white sky-mirror patch).
	let Nup = normalize( mix( surf.normal, vec3f( 0.0, 1.0, 0.0 ), whaleW.y * 0.75 ) );
	let Nside = select( Nup, - Nup, viewFromBelow );
	let Nview = normalize( Nside + V * max( - dot( Nside, V ) + 0.03, 0.0 ) );

	// roughness from unresolved slope variance (Cox-Munk: mss = 0.003 + 0.00512 U)
	let mss = ( 0.003 + frame.windSpeed * 0.00512 ) * waterSurface.slopeScale;
	let kpx = PI / footprint;
	let unresolved = sat( log2( 110.0 / kpx ) / 9.0 );
	let roughVar = surf.rough * surf.rough;
	let alpha2 = ( mat.waterRoughness * mat.waterRoughness + mss * 2.0 * unresolved * roughVar + foam * 0.2 + surf.aeration * 0.03 ) * ( 1.0 - whaleW.y * 0.6 );
	// slope spread the mesh / normal maps can't show at this distance (for the reflection)
	let sigmaUnres = sqrt( mss * unresolved * roughVar );

	var outCol = vec3f( 0.0 );
	var ssrW = 0.0;
	var dbgPath = 0.0;
	var dbgScene = vec3f( 0.0 );
	var dbgSrc = vec3f( 0.0 ); // which image the seabed came from (debug view 12)
	var dbgRefr = vec3f( 0.0 ); // refraction image at the end point: coverage, depth > 0, behind (13)

	if ( ! viewFromBelow ) {

		// ================= ABOVE WATER =================
		// near the leading edge the surface bends down to meet the sand like a rounded bead
		// (meniscus), tilting the normal toward dry land
		let edgeW = max( ( 1.0 - smoothstep( 0.0, 0.006, thickness ) ) * uprush, lipW );
		let nr = ${ T ? 'terrainNormalRock( pos.xz )' : 'vec4f( 0.0 )' };
		let uphill = normalize( - vec2f( nr.x, nr.y ) + vec2f( 1e-5, 0.0 ) );
		let N = normalize( Nview + vec3f( uphill.x, 0.0, uphill.y ) * ( edgeW * edgeW * 0.7 ) );
		let NdV = max( dot( N, V ), 1e-4 );
		let F = fresnelDielectric( NdV, ${ IOR } );

		// ---- reflection
		let Rraw = reflect( - V, N );
		// unresolved facets tilt the average reflection toward the higher, darker sky: rough
		// patches (gusts) darken toward the horizon, slicks stay bright and mirror-like
		let Rup = max( Rraw.y, 0.004 ) + sigmaUnres * 1.3 * ( 1.0 - max( Rraw.y, 0.0 ) );
		let R = normalize( vec3f( Rraw.x, Rup, Rraw.z ) );
		// reflections pointing below the horizon hit other waves: fade toward a dark sea color
		let horizonOcc = max( smoothstep( -0.12, 0.08, Rraw.y ), smoothstep( 0.25, 0.06, thickness ) );
		// (unused where both its weights are 0: horizonOcc here, the rim at the swash front below)
		var skyRefl = vec3f( 0.0 );
		if ( horizonOcc > 0.0 || frontD < 0.1 ) { skyRefl = skyReflectionRadiance( R ); }
		var reflCol = mix( frame.horizonColor * 0.35, skyRefl, horizonOcc );

		// objects (pier, boat, hills, village) reflected from the screen; only rays close to the
		// horizon can hit anything, so steep reflections skip the march entirely
		// (looking down, F is tiny: the reflection can't be seen, skip the march)
		if ( Rraw.y < 0.45 && F > 0.05 && mat.ssr > 0.5 ) {
			let Rv = normalize( ( frame.view * vec4f( Rraw, 0.0 ) ).xyz );
			// (rays toward the camera get no weight: see facing in _waterSSR)
			if ( Rv.z < 0.5 ) {
				let r = _waterSSR( posV, Rv, pos.y, Rraw.y );
				reflCol = mix( reflCol, r.rgb, r.a );
				ssrW = r.a;
			}
		}
${ REFL ? `
		// planar reflection of scene objects (alpha = coverage)
		let rOffset = N.xz * 0.8 / max( dist, 1.0 ) * 4.0;
		let rs = reflectionSample( screenUV, rOffset );
		reflCol = mix( reflCol, rs.rgb, rs.a );` : '' }

		reflCol *= mat.reflectionStrength;

		// ---- sun specular (GGX), sun light already includes shadowing
		let H = normalize( L + V );
		let NdL = max( dot( N, L ), 0.0 );
		let NdH = max( dot( N, H ), 0.0 );
		let VdH = max( dot( V, H ), 0.0 );
		let Fs = fresnelDielectric( VdH, ${ IOR } );
		let spec = _waterDGGX( NdH, alpha2 ) * _waterVSmithGGX( NdL, NdV, alpha2 ) * Fs * NdL;
		// physically the glint is ~1e5x brighter than the sky; clamp to stay inside fp16 range
		let sunSpec = sunLight * min( spec, 400.0 );

		// ---- refraction / water volume
		// Trace the refracted view ray (Snell) to the sea floor instead of using the straight
		// screen ray: at grazing angles the straight ray overestimates the water path ~10x.
		// view ray inside the water (unit, downward). Facets of a curling crest can refract it
		// upward on a coarse mesh; keep it heading down into the water body.
		let Tr = refract( - V, N, 1.0 / ${ IOR } );
		let Tv = normalize( vec3f( Tr.x, min( Tr.y, -0.08 ), Tr.z ) );
		let tDown = max( - Tv.y, 0.04 );
		let surfViewZ = posV.z;

		// water column below the surface along the refracted ray (terrain, 2 refinements)
${ T ? `		let L0 = max( pos.y - groundH, 0.0 ) / tDown;
		// deep water: the end point is capped at 80 m and the column is opaque long before, so the
		// refinements can't change the result
		var Lt = L0;
		if ( L0 < 100.0 ) {
			let L1 = max( pos.y - terrainHeightAt( pos.xz + Tv.xz * min( L0, 200.0 ) ), 0.0 ) / tDown;
			Lt = max( pos.y - terrainHeightAt( pos.xz + Tv.xz * min( L1 * 0.5 + L0 * 0.5, 200.0 ) ), 0.0 ) / tDown;
		}` : '		let Lt = 400.0;' }
		let Lter = clamp( Lt, 0.0, 400.0 );
		// thin breaking crests: the refracted ray leaves through the back of the wave into the sky
		let crestT = ${ hasCrest ? 'shoreCrestPath( lagXZ, vDepth, Tv )' : '1e4' };
		let thruCrest = crestT < Lter;

		// project the refracted end point to the screen
		let pEnd = pos + Tv * min( Lter, 80.0 );
		let clipEnd = frame.proj * ( frame.view * vec4f( pEnd, 1.0 ) );
		let ndcEnd = clipEnd.xy / max( clipEnd.w, 1e-4 );
		let uvR = vec2f( ndcEnd.x * 0.5 + 0.5, ndcEnd.y * -0.5 + 0.5 );
		let onScreen = all( uvR > vec2f( 0.0 ) ) && all( uvR < vec2f( 1.0 ) );
		var uvF = screenUV;
		var dR = 0.0;
		var sceneCol = vec3f( 0.0 );
		var found = false;
#if WATER_REFRACTION
		// the scene below the water only (RefractionPass): nothing above the water (pier, rails, posts,
		// the boat) can hide the refracted end point. Coverage in alpha: bilinear across its edge, then
		// un-premultiplied, so the clip boundary blends instead of darkening.
		// The image extends past the screen (RefractionPass guard band): the refracted end points of the
		// pixels near the bottom edge land below the screen (light bends down into the water), and the
		// seabed there is drawn. Lookups project with this frame's jittered camera, as the image was.
		{
			let cj = frame.viewProj * vec4f( pEnd, 1.0 );
			let uvRc = _waterRefrUV( cj.xy / max( cj.w, 1e-4 ) );
			let rc = textureSampleLevel( waterRefrColor, smpLinearClamp, uvRc, 0.0 );
			let rSize = vec2f( textureDimensions( waterRefrDepth ) );
			let rd = textureLoad( waterRefrDepth, vec2i( min( uvRc * rSize, rSize - 1.0 ) ), 0 ).x;
			// only what lies behind this surface point can be seen through it: submerged parts of
			// objects in front of it (the hull of the boat you stand in, pier piles) would otherwise be
			// pasted onto the sea far out, wherever the end point lands on them (or off screen next to
			// them: the edge texel)
			dbgRefr = vec3f( rc.a, select( 0.0, 1.0, rd > 0.0 ), select( 0.0, 1.0, surfViewZ + viewDepth( rd ) > WATER_BEHIND ) );
			if ( rc.a > 0.5 && rd > 0.0 && surfViewZ + viewDepth( rd ) > WATER_BEHIND ) {
				sceneCol = rc.rgb / rc.a;
				uvF = uvR;
				dR = rd;
				found = true;
			} else if ( rc.a > 0.5 && rd > 0.0 ) {
				// the end point lies on something in front (a pile, a hull): what lies straight behind
				// this pixel, from the same (lit) source. The opaque copy shades deep seabed cheaply and
				// flickered against it as the piles passed in front while walking the pier.
				let uvS = _waterRefrUV( vec2f( screenUV.x * 2.0 - 1.0, 1.0 - screenUV.y * 2.0 ) );
				let rcS = textureSampleLevel( waterRefrColor, smpLinearClamp, uvS, 0.0 );
				let rdS = textureLoad( waterRefrDepth, vec2i( min( uvS * rSize, rSize - 1.0 ) ), 0 ).x;
				if ( rcS.a > 0.5 && rdS > 0.0 && surfViewZ + viewDepth( rdS ) > WATER_BEHIND ) {
					sceneCol = rcS.rgb / rcS.a;
					uvF = screenUV;
					dR = rdS;
					found = true;
				}
			}
		}
#endif
		if ( ! found ) {
			// nothing under the water there (shallows above the clip height, off screen): the opaque copy,
			// where the refracted sample lies behind the water surface, else the unrefracted pixel
			let dO = _waterSceneDepthAt( uvR );
			let valid = onScreen && surfViewZ + viewDepth( dO ) > WATER_BEHIND;
			uvF = select( screenUV, uvR, valid );
			dR = select( _waterSceneDepthAt( screenUV ), dO, valid );
			sceneCol = textureSampleLevel( waterSceneColor, smpLinearClamp, uvF, 0.0 ).rgb;
		} else {
			// Thin water (the swash film on the sand): the refraction offset is a few pixels at most and
			// nothing can stand between the film and the sand, so the opaque pass's own image of the sand
			// is the right one: it has the wet swash sand and its ripples, which the refraction image
			// draws as plain seabed and leaves out altogether above its clip height (0.4 m). Switching
			// between the two there drew a hard straight line across the wet sand along that height.
			let filmW = 1.0 - smoothstep( 0.04, 0.3, thickness );
			if ( filmW > 0.0 ) {
				let dO = _waterSceneDepthAt( uvR );
				let uvO = select( screenUV, uvR, onScreen && surfViewZ + viewDepth( dO ) > WATER_BEHIND );
				sceneCol = mix( sceneCol, textureSampleLevel( waterSceneColor, smpLinearClamp, uvO, 0.0 ).rgb, filmW );
			}
		}
		// (a branch: select() would evaluate the sky for every pixel)
		if ( thruCrest ) { sceneCol = skyReflectionRadiance( normalize( vec3f( Tv.x, max( abs( Tv.y ), 0.03 ), Tv.z ) ) ); }

		// objects in front of the sea floor (pylons, rocks, reef) shorten the path
		let qView = viewPositionFromViewZ( uvF, - viewDepth( dR ) );
		let qDist = length( qView - posV );
		var pathLen = clamp( min( Lter, qDist ), 0.0, 400.0 );
		pathLen = min( pathLen, crestT );
		dbgPath = pathLen;
		dbgScene = sceneCol;
		dbgSrc = select( vec3f( 1.0, 0.0, 0.0 ), vec3f( 0.0, 1.0, 0.0 ), found );

		// bubbles mixed into the water (the surf behind breakers, wakes): a strong scatterer, the water
		// turns milky turquoise and the bottom disappears (WaterSurface.fragment aeration)
		let aer = surf.aeration;
		// sand stirred up where the bores have just passed (the foam they left marks that water):
		// clouds of sediment, not a uniform tint
		let sandK = ${ SIM ? 'sat( simState.x * 2.5 ) * 1.8 + 0.45' : '1.0' };
${ hasMedium ? `		// surf zone: sand and bubbles stirred up by the breakers (see ShoreWaves.surfMedium)
		let surfMed = shoreSurfMedium( pos.xz, vDepth );
		let sigA = ${ S.terrain ? 'terrainInlandAbsorption( pos.xz, frame.waterAbsorption )' : 'frame.waterAbsorption' } + surfMed.absorb * sandK;
		// (bubble plumes are shallow and patchy: a moderate scatterer, milky turquoise rather than a glow)
		let sigS = ${ S.terrain ? 'terrainInlandScattering( pos.xz, frame.waterScattering )' : 'frame.waterScattering' } + surfMed.scatter * sandK + aer * 1.6;` : `		let sigA = ${ S.terrain ? 'terrainInlandAbsorption( pos.xz, frame.waterAbsorption )' : 'frame.waterAbsorption' };
		let sigS = ${ S.terrain ? 'terrainInlandScattering( pos.xz, frame.waterScattering )' : 'frame.waterScattering' } + aer * 1.6;` }
		let sigT = sigA + sigS;

		// refracted sun direction
		let Ls = - refract( - L, vec3f( 0.0, 1.0, 0.0 ), 1.0 / ${ IOR } ); // toward the sun from underwater
		let muS = max( Ls.y, 0.1 );
		let muV = max( - Tv.y, 0.15 );

		let Tview = exp( - sigT * pathLen );

		// in-scattered light along the view ray (single scattering sun + ambient), analytic
		// light at depth z: E0 * exp(-sigT * z / mu). Along the view ray z = s * muV.
		let sunIn = sunLight * ( 1.0 - fresnelDielectric( max( L.y, 0.02 ), ${ IOR } ) );
		let kSun = sigT * ( 1.0 + muV / muS );
		let kAmb = sigT * ( 1.0 + muV / 0.75 );
		let cosPh = dot( Tv, Ls );
		let phase = waterPhaseHG( cosPh, 0.86 ) * 0.7 + ${ ( 0.3 / ( 4 * Math.PI ) ).toFixed( 8 ) };
		let bb = sigS * mix( mat.backscatter, 0.06, sat( aer * 2.0 ) );
		// multiple-scattering boosted backscatter (Gordon R = 0.33 bb/(a+bb))
		let albedoMS = bb * ( 0.33 * 4.0 ) / ( sigA + bb );
		let inSun = sunIn * ( sigS * phase + albedoMS * sigT * INV_PI ) * ( 1.0 - exp( - kSun * pathLen ) ) / kSun;
		let inAmb = frame.skyIrradiance * ( sigS * 0.25 + albedoMS * sigT ) * ( 1.0 - exp( - kAmb * pathLen ) ) / kAmb;

		// crest translucency (sun shining through thin wave tips)
		let vH = normalize( vec2f( V.x, V.z ) );
		let lH = normalize( vec2f( L.x, L.z ) + 1e-5 );
		// (light entering the top and back of a thin crest scatters out of the face over a broad lobe:
		// side-lit waves glow green too, not only when looking straight into the sun)
		let back = pow( sat( dot( vH, - lH ) * 0.6 + 0.4 ), 2.5 );
		let crest = sat( vHeight * 0.9 + 0.1 ) * ( sat( ( 1.0 - N.y ) * 4.0 ) + 0.25 );
		let sssCol = vec3f( 0.12, 0.55, 0.45 ) * 0.06;
		let sss = sunLight * sssCol * back * crest * mat.sss * smoothstep( 0.0, 0.25, L.y );

		// the bead of the meniscus shades the sand right under it
		let transmitted = sceneCol * Tview * ( 1.0 - 0.3 * lipW ) + inSun + inAmb + sss;

		// ---- foam
		// foam: bright diffuse scatterer (albedo ~0.85), wrapped sun + sky irradiance (skyIrradiance = E/PI)
${ SF ? '		let foamLit = surfFoamLight( surf.foamInfo, N, L, V, sunLight, pos );' : '		let foamLit = ( sunLight * ( max( dot( N, L ), 0.0 ) * 0.75 + 0.25 ) * INV_PI + frame.skyIrradiance * 0.95 ) * 0.85;' }
		let foamCol = foamLit * mat.foamIntensity;

		// a thin bright rim just behind the edge: the rounded bead catches the sky
		let rim = smoothstep( 0.0, 0.025, frontD ) * smoothstep( 0.1, 0.035, frontD ) * uprush;
		let water = mix( transmitted, reflCol, F ) + sunSpec + skyRefl * ( 0.22 * rim );
		let shaded = mix( water, foamCol + sunSpec * 0.05, sat( foam ) );
		// fade into the sand right at the leading edge (anti-aliased by the film thickness)
		let edgeAA = smoothstep( 0.0, max( fwidth( thickness ) * 1.5, 0.004 ), thickness );
		// contact shadow: the sand just ahead of the advancing edge is darkened (the bead's
		// shadow and the wetting front), fading within ~15 cm
		outCol = shaded;
		if ( edgeAA < 1.0 ) {
			let contact = smoothstep( -0.16, -0.005, frontD ) * ( 1.0 - edgeAA ) * uprush;
			let sandC = textureSampleLevel( waterSceneColor, smpLinearClamp, screenUV, 0.0 ).rgb * ( 1.0 - 0.3 * contact );
			outCol = mix( sandC, shaded, edgeAA );
		}

	} else {

		// ================= BELOW WATER (looking up at the surface) =================
		let N = Nview;
		let NdV = max( dot( N, V ), 1e-4 );
