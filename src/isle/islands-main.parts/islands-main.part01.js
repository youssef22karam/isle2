// Tidewater Islands — tidewater's sea, boat, shoreline waves, sky, sun and
// lighting over island29's infinite procedural archipelago (single-file
// build, all WebGPU).
//
// What is tidewater's, unmodified (construction and per-frame order follow
// the game's own App.js): the engine, OceanFFT sea, WaterSurface /
// WaterMaterial, ShoreWaves + ShoreSim + SurfFoam + Breakers + Spray
// shoreline machinery, Caustics, SeaDetail, WaterQuery, Sky / Atmosphere /
// Environment + SunShadows lighting, the BoatModel + BoatController +
// BoatSpray + WakeSim boat, and the Player walker/swimmer/captain.
//
// What is island29's: the infinite archipelago — 8,000 m cells, ~72% with
// an island, generated/streamed as you move, no boundary — and the island
// terrains themselves: islands/IslandGen.js drives island29's own terrain
// generator (the verbatim worker modules under islands/gen/), so the
// islands come with their full geo terrain — archetypes, erosion, the
// river/lake/marsh hydrology network and the geology sculpt included.
//
// What is mine (glue): islands/ArchipelagoData.js (the archipelago behind
// tidewater's TerrainData interface, with a floating origin so the world
// is endless inside a fixed 2048 m terrain domain), islands/Hud.js
// (island29's control scheme driving tidewater's Player), and this file.
//
// Excluded by the recipe: kelp/underwater systems, trees/grass/vegetation,
// tidewater's village/pier/props/fishing game, PostFX (a plain present
// pass stands in, as in the earlier tidewater-sea build) and the
// refraction pass (as in that build).
//
// Sun, day/night cycle, clouds and weather (added 2026-11-27): the sun
// already followed the game's own settings/updateSun path; the cycle now
// runs (timeSpeed > 0) and tidewater's volumetric clouds (sky/Clouds.js,
// unmodified) are wired in the game's own order and handed to every
// consumer the game hands them to. The HUD's menu carries the controls —
// sun/time, cloud cover + cirrus, and the sea-state presets + sliders
// from the game's own panel (ui/AppUI.js) — bound through
// islands/EnvControls.js, which writes to the same live objects.

import './islands/park-reef.js'; // FIRST: parks WORLD.reef before Terrain.js bakes it (see the file)
import { Engine } from './engine/Engine.js';
import { Vector2, Vector3, Color, MathUtils, Mesh } from './engine/index.js';
import { GPU, FullscreenPass, FrameUniforms, setFrameCamera } from './engine/webgpu.js';
import { G } from './core/Globals.js';
import { SceneRenderer, LAYERS } from './core/SceneRenderer.js';
import { Input } from './core/Input.js';
import { Atmosphere, SUN_ILLUMINANCE } from './sky/Atmosphere.js';
import { Sky, sunDirectionFromTime } from './sky/Sky.js';
import { Clouds } from './sky/Clouds.js';
import { Environment } from './sky/Environment.js';
import { SunShadows } from './engine/webgpu.js';
import { OceanFFT } from './ocean/OceanFFT.js';
import { WaterSurface } from './ocean/WaterSurface.js';
import { WaterMaterial } from './ocean/WaterMaterial.js';
import { ShoreWaves } from './ocean/ShoreWaves.js';
import { ShoreSim } from './ocean/ShoreSim.js';
import { SurfFoam } from './ocean/SurfFoam.js';
import { Breakers } from './ocean/Breakers.js';
import { Spray } from './fx/Spray.js';
import { Caustics } from './ocean/Caustics.js';
import { SeaDetail } from './ocean/SeaDetail.js';
import { WaterQuery } from './ocean/WaterQuery.js';
import { WakeSim } from './ocean/WakeSim.js';
import { createFoamTexture } from './ocean/FoamTexture.js';
import { CDLOD } from './core/CDLOD.js';
import { computeShoreField } from './world/ShoreField.js';
import { TerrainGPU } from './world/TerrainGPU.js';
import { Terrain } from './world/Terrain.js';
import { Colliders } from './world/Colliders.js';
import { BoatModel } from './world/BoatModel.js';
import { WORLD } from './world/WorldLayout.js';
import { Player } from './player/Player.js';
import { BoatController } from './player/BoatController.js';
import { BoatSpray } from './player/BoatSpray.js';
import { installUnderwaterLighting } from './ocean/UnderwaterLighting.js';
import { installGroundBounce } from './materials/GroundBounce.js';
import { bakeTerrainMaps, buildShadowHeights } from './world/terrain/TerrainBake.js';
import { generateMipmaps } from './engine/gpu/Mipmaps.js';
import { ArchipelagoData } from './islands/ArchipelagoData.js';
import { packHeightTexels } from './world/TerrainGPU.js';
import { seaDistance } from './islands/IslandGen.js';
import { islandDescriptor, WORLD_SEED } from './islands/IslandGen.js';
import { InputFacade, LookCam, Hud } from './islands/Hud.js';
import { createEnvControls } from './islands/EnvControls.js';
import { QUALITY_PROFILES, resolveQuality, saveQuality, needsRebuild, effectiveRenderScale } from './islands/Quality.js';

const _up = new Vector3( 0, 1, 0 );
const SHIFT_AT = 820; // shift the floating origin when the player strays this far (m) from local origin
const SHIFT_STEP = 256; // shifts are multiples of this, bringing the player back near the origin

class IslandsApp {

	constructor( container ) {

		this.container = container;
		this.settings = { timeOfDay: 10.5, sunAzimuth: 0, timeSpeed: 0, exposure: 0.55, renderScale: 1 };
		this.camWaterH = 0;
		this.qualityName = resolveQuality();
		this.profile = QUALITY_PROFILES[ this.qualityName ];
		this.mode = 'walk'; // UI mode: 'look' | 'walk' | 'boat' (boat ⇔ player is at the helm)
		this.shifting = false;
		this._shiftCheckT = 0;

	}

	setQuality( name ) {

		if ( ! QUALITY_PROFILES[ name ] || name === this.qualityName ) return;
		saveQuality( name );
		const target = QUALITY_PROFILES[ name ];
		const rebuild = needsRebuild( this.profile, target );
		this.qualityName = name;
		this.profile = target;
		this.settings.renderScale = effectiveRenderScale( target );
		if ( this.engine ) this.engine.setRenderScale( this.settings.renderScale );
		if ( this.clouds ) this.clouds.resolutionScale = this.settings.renderScale; // App.js's setRenderScale does the same
		if ( this.shadows ) this.shadows.enabled = target.shadows;
		if ( this.hud ) this.hud.setQualityUI( name, rebuild ? 'Applying — reloading…' : '' );
		if ( rebuild ) setTimeout( () => window.location.reload(), 450 );

	}

	// ------------------------------------------------------------ modes (island29's buttons)
	setMode( mode ) {

		const p = this.player;
		if ( mode === 'look' ) {

			this.mode = 'look';
			this.lookCam.init = false;
			return;

		}
		if ( mode === 'walk' ) {

			this.mode = 'walk';
			if ( p.mode === 'boat' ) { p.leaveHelm(); p.exitBoat(); }
			else if ( p.mode === 'deck' ) p.exitBoat();
			return;

		}
		if ( mode === 'dive' ) {

			if ( this.hooks && this.hooks.onDiveRequest ) this.hooks.onDiveRequest();
			return;

		}
		if ( mode === 'boat' ) {

			this.mode = 'boat';
			if ( p.mode === 'walk' || p.mode === 'swim' ) p.enterBoat();
			else if ( p.mode === 'deck' ) p.takeHelm();

		}

	}

	async init( progress = () => {} ) {

		const profile = this.profile;
		const engine = this.engine = new Engine( this.container );
		await engine.init();
		engine.renderScale = effectiveRenderScale( profile );
		this.settings.renderScale = engine.renderScale;
		engine.resize();
		const { scene, camera } = engine;
		this.scene = scene;
		this.camera = camera;
		camera.near = 0.1;
		camera.updateProjectionMatrix();
		const renderer = engine.meshRenderer;
		this.renderer = renderer;

		progress( 'Sky…' );
		const atmosphere = this.atmosphere = new Atmosphere( renderer );
		const sky = this.sky = new Sky( atmosphere );
		// clouds, in the game's own order (App.js): constructed with the
		// sky, then handed to it before anything builds a shader. This is
		// tidewater's volumetric cloud system (sky/Clouds.js, unmodified) —
		// the game's ?oldClouds configuration. Its current default
		// (sky/SkyProClouds.js) fetches two external noise blobs
		// (public/clouds/*.bin, ~900 KB) over HTTP at runtime, which this
		// single-file build cannot serve; Clouds.js is fully procedural.
		const clouds = this.clouds = new Clouds( renderer, atmosphere );
		sky.clouds = clouds;
		clouds.resolutionScale = engine.renderScale; // App.js ties it to the render scale
		const shadows = this.shadows = new SunShadows( { size: profile.shadowSize, splits: [ 10, 60, 400 ], lightMargin: 200, normalBias: [ 0.015, 0.06, 0.3 ], bias: 0.00002 } );
		shadows.enabled = profile.shadows;
		shadows.layerMask = ( 1 << LAYERS.OPAQUE ) | ( 1 << LAYERS.TRANSPARENT );
		this.environment = new Environment( renderer, scene, sky );

		// ---- the archipelago: generate the home island, find its spawn
		// beach, then put the floating-origin window ON that beach (local
		// (0, -45)) — the window starts where the player starts, and the
		// beach lands inside tidewater's breaker-station transect, which by
		// the game's own design scans the shore near the domain centre.
		progress( 'Raising the home island…' );
		await nextFrame();
		// the world seed: island29's app default (App.tsx runs seed 504 and
		// honours ?seed= the same way). The provider and the descriptor must
		// agree on it — a mismatch silently generates a different archipelago.
		const worldSeed = Number( new URLSearchParams( location.search ).get( 'seed' ) ) || WORLD_SEED;
		const data = this.data = new ArchipelagoData( 2048, 1024, worldSeed );
		const homeDesc = islandDescriptor( 0, 0, worldSeed );
		// the full island29 generator runs in seconds per island; pump it
		// asynchronously so the loader paints kn's own stage labels
		await data.generateIslandAsync( homeDesc, ( p ) => { if ( p.label ) progress( p.label + '…' ); } );
		const spawn = data.findSpawn( homeDesc );
		if ( ! spawn ) throw new Error( 'No beach found on the home island (seed ' + worldSeed + ')' );
		const beachV = { x: homeDesc.cx + spawn.beach.x, z: homeDesc.cz + spawn.beach.z }; // virtual coords
		const boatV = { x: homeDesc.cx + spawn.boat.x, z: homeDesc.cz + spawn.boat.z };
		data.setOffset( Math.round( beachV.x ), Math.round( beachV.z + 45 ) );
		for ( const desc of data.missingIslands() ) await data.generateIslandAsync( desc, ( p ) => { if ( p.label ) progress( p.label + '…' ); } );
		data.refill();

		const beachPos = new Vector3( beachV.x - data.offsetX, 0, beachV.z - data.offsetZ );
		beachPos.y = data.heightAt( beachPos.x, beachPos.z );
		const boatPos = new Vector3( boatV.x - data.offsetX, 0, boatV.z - data.offsetZ );
		this.spawnInfo = { beachPos, boatPos, yaw: spawn.beach.yaw, heading: spawn.boat.heading };

		// tidewater's layout object is runtime configuration: point its spawn
		// and dock at this archipelago's beach (the module itself is untouched)
		WORLD.start.position.copy( beachPos );
		WORLD.start.yaw = spawn.beach.yaw;
		WORLD.spawn.position.copy( beachPos );
		WORLD.spawn.yaw = spawn.beach.yaw;
		WORLD.boatDock.position.copy( boatPos );
		WORLD.boatDock.heading = spawn.boat.heading;
		// (WORLD.reef is handled by islands/park-reef.js, imported first
		// above: Terrain.js bakes the reef centre into its shader at
		// module-evaluation time, before any of this code runs.)

		progress( 'Shores…' );
		await nextFrame();
		const shoreField = computeShoreField( data, { res: 512, swellDir: [ WORLD.swellDir.x, WORLD.swellDir.y ] } );
		const terrainGPU = this.terrainGPU = new TerrainGPU( data, shoreField );
		const terrain = this.terrain = new Terrain( { scene, terrainData: data, terrainGPU, renderer, gridSize: profile.terrainGrid } );
		terrain.mesh.material.appliesHillShadow = true;

		progress( 'Ocean…' );
		const fft = this.fft = new OceanFFT( renderer ); // constructed with the game's default spectrum (Breezy)
		const foamTexture = createFoamTexture( renderer, profile.foamSize );
		const oceanLOD = this.oceanLOD = new CDLOD( { gridSize: profile.oceanGrid, leafSize: 8, levels: profile.oceanLevels, minY: - 25, maxY: 25 } );
		const surface = this.surface = new WaterSurface( { fft, cdlod: oceanLOD, foamTexture } );
		surface.terrain = terrainGPU;
		const seaDetail = this.seaDetail = new SeaDetail();
		surface.detail = seaDetail;
		const shore = this.shore = new ShoreWaves( terrainGPU );
		surface.shore = shore;
		const caustics = this.caustics = profile.caustics ? new Caustics( renderer, fft ) : null;
		if ( caustics ) caustics.detail = seaDetail;
		// the surf-sim window: 1200 m across (the game's own bay sim is
		// 380 m, but its whole world is one bay whose window edges sit in
		// deep water / on the headlands by construction). At 560 m the
		// window's edge crossed the spawn bay's shallows and the change of
		// treatment at the border drew a hard rectangle in the water
		// (playtest 2026-11-27 10:10); at 1200 m the edge sits in deep
		// water or on land in practice, and the window additionally
		// follows the player (see maybeFollowShoreSim) so the border is
		// never near the shore being looked at. Sim texel sizes stay in
		// the game's own range via profile.shoreRes (see Quality.js).
		const shoreSim = this.shoreSim = new ShoreSim( renderer, { terrainGPU, shore, center: new Vector2( beachPos.x, beachPos.z ), size: 1200, res: profile.shoreRes } );
		surface.shoreSim = shoreSim;

		// tidewater's own wetness hook, VERBATIM from the game's App.js (the
		// contract Terrain.js documents: fn terrainWetness( xz: vec2f, h: f32 )
		// -> vec2f, x = wetness, y = sand foam). A previous hand-written variant
		// with a different signature called ShoreSim functions with the wrong
		// arity, which made the whole terrain fragment shader fail WGSL
		// compilation — the terrain pipeline was invalid and the mesh was
		// silently skipped every frame (the black-island bug, 2026-11-27;
		// compiler-proven, see REPORT.md). Do not paraphrase this code.
		terrain.wetness = {
			modules: [ shoreSim.module ],
			code: /* wgsl */`
fn terrainWetness( xz: vec2f, h: f32 ) -> vec2f {
	let s = shoreSimSample( xz );
	let inside = shoreSimInside( shoreSimUvOf( xz ) );
	// outside the simulated region fall back to a static damp band
	let band = smoothstep( 0.45, 0.0, h );
	// foam left on the sand: the lace the water carried, stranded and popping (ShoreSim.sandFoam)
	return vec2f( max( s.y, band * ( 1.0 - inside ) ), shoreSimSandFoam( xz, s, h ) );
}`,
		};
		terrain.finalizeMaterial();

		const surfFoam = new SurfFoam( { shoreSim } );
		surface.foamShading = ( args ) => surfFoam.shading( args );

		this.underwaterLighting = installUnderwaterLighting( { fft, caustics, clouds, terrain: terrainGPU, shore, surface, shoreSim } );
		installGroundBounce( { terrain: terrainGPU, clouds } );

		const sceneRenderer = this.sceneRenderer = new SceneRenderer( renderer, scene, camera );
		sceneRenderer.setSize( engine.width, engine.height );
		sceneRenderer.background = sky.background;
		const onResize = () => sceneRenderer.setSize( engine.width, engine.height );
		if ( Array.isArray( engine.onResize ) ) engine.onResize.push( onResize ); else engine.onResize = onResize;

		const waterMaterial = this.waterMaterial = new WaterMaterial( {
			surface, sky, sceneCopy: sceneRenderer.opaqueCopy, sceneDepthHalf: sceneRenderer.opaqueDepthHalf.texture,
			hullMask: sceneRenderer.hullMaskRT.texture, hullMaskActive: sceneRenderer.hullMaskActive,
		} );
		waterMaterial.clouds = clouds; // the app sets it before the first frame (App.js)
		const ocean = new Mesh( oceanLOD.geometry, waterMaterial );
		ocean.frustumCulled = false;
		ocean.receiveShadow = true;
		ocean.layers.set( LAYERS.WATER );
		scene.add( ocean );
		this.oceanMesh = ocean;

		const query = this.query = new WaterQuery( renderer, surface );
		waterMaterial.cameraWaterHeightNode = query.cameraState().x;

		const spray = this.spray = new Spray( renderer, { query, terrain: terrainGPU, sceneCopy: sceneRenderer.opaqueCopy, clouds, gpuCapacity: profile.sprayGPU, cpuCapacity: profile.sprayCPU } );
		scene.add( spray.mesh );
		this.breakers = new Breakers( renderer, { surface, shore, terrainData: data, sky, spray, clouds } );
		scene.add( this.breakers.mesh );

		// ---- the boat (tidewater's model + controller + spray + wake)
		progress( 'The boat…' );
		const boat = this.boat = new BoatModel();
		scene.add( boat.group );
		boat.group.position.copy( WORLD.boatDock.position );
		boat.group.rotation.y = WORLD.boatDock.heading;
		boat.group.traverse( ( o ) => {

			if ( o.material ) for ( const mat of Array.isArray( o.material ) ? o.material : [ o.material ] ) mat.underwaterLighting = 'lite';

		} );
		sceneRenderer.addHullMask( boat.createHullVolumeGeometry(), boat.group );
		const colliders = this.colliders = new Colliders(); // empty: no village/pier geometry in an archipelago
		const boatCtl = this.boatCtl = new BoatController( { model: boat, query, terrain: data, colliders } );
		const boatSpray = this.boatSpray = new BoatSpray( { boat: boatCtl, spray } );
		const wake = this.wake = new WakeSim( renderer, { terrainGPU, boat: boatCtl, colliders } );

		// ---- the player, driven by island29's control scheme
		const input = this.input = new InputFacade( new Input( engine.canvas ) );
		const player = this.player = new Player( { camera, input, terrain: data, colliders, query, boat: boatCtl, reef: null } );
		this.lookCam = new LookCam();
		this.lookCam.yaw = spawn.beach.yaw + Math.PI; // start looking out to sea, island behind… (orbit pos behind player)

		// sun/time, clouds + weather controls: bound to the LIVE systems
		// (the very objects above), with the game's own panel values and
		// push semantics (see islands/EnvControls.js). Creating it starts
		// the day/night cycle: advance on, at the gentle default rate.
		const envControls = this.envControls = createEnvControls( {
			settings: this.settings, fft, shore, breakers: this.breakers, caustics, clouds, globals: G, math: MathUtils,
		} );

		this.hud = new Hud( {
			facade: input,
			onMode: ( m ) => this.setMode( m ),
			onQuality: ( q ) => this.setQuality( q ),
			env: envControls,
		} );
		this.hud.setQualityUI( this.qualityName, '' );
		this.bindCanvasGestures();
		this.bindKeys();

		// present pass: exposure + filmic + sRGB (stands in for PostFX, as in the sea build)
		this.present = new FullscreenPass( {
			label: 'present',
			colorFormats: [ navigator.gpu.getPreferredCanvasFormat() ],
			bindings: { sceneColor: { texture: () => this.sceneRenderer.sceneRT.texture } },
			code: /* wgsl */`
fn fragment( in: FSIn ) -> vec4f {
	var c = textureLoad( sceneColor, vec2i( in.pos.xy ), 0 ).rgb * frame.exposure;
	c = clamp( ( c * ( 2.51 * c + 0.03 ) ) / ( c * ( 2.43 * c + 0.59 ) + 0.14 ), vec3f( 0.0 ), vec3f( 1.0 ) );
	return vec4f( pow( c, vec3f( 1.0 / 2.2 ) ), 1.0 );
}`,
		} );

		G.exposure.value = this.settings.exposure;
		this.updateSun();
		progress( 'Compiling shaders…' );
		await GPU.pipelinesReady();
		for ( let i = 0; i < 3; i ++ ) {

			this.frame( 1 / 60 );
			await GPU.queue.onSubmittedWorkDone();

		}
		engine.start( ( dt ) => this.frame( dt ) );

	}

	// ------------------------------------------------------------ input gestures
	bindCanvasGestures() {

		const canvas = this.engine.canvas;
		const pointers = new Map();
		let pinchD = 0;
		canvas.addEventListener( 'pointerdown', ( e ) => {

			pointers.set( e.pointerId, { x: e.clientX, y: e.clientY } );
			if ( pointers.size === 2 ) {

				const [ a, b ] = [ ... pointers.values() ];
				pinchD = Math.hypot( a.x - b.x, a.y - b.y );

			}
			// desktop: click to pointer-lock for mouse look (the game's Input
			// also drags-looks without lock)
			if ( e.pointerType === 'mouse' && this.mode !== 'look' ) this.input.real.requestLock();

		} );
		canvas.addEventListener( 'pointermove', ( e ) => {

			const p = pointers.get( e.pointerId );
			if ( ! p ) return;
			const dx = e.clientX - p.x, dy = e.clientY - p.y;
			p.x = e.clientX;
			p.y = e.clientY;
			if ( pointers.size === 2 ) {

				const [ a, b ] = [ ... pointers.values() ];
				const nd = Math.hypot( a.x - b.x, a.y - b.y );
				if ( pinchD > 0 && nd > 0 ) {

					if ( this.mode === 'look' ) this.lookCam.zoom( pinchD / nd );
					else if ( this.player.mode === 'boat' ) this.input.addWheel( ( pinchD - nd ) * 0.02 );

				}
				pinchD = nd;
				return;

			}
			if ( e.pointerType === 'touch' ) {

				if ( this.mode === 'look' ) this.lookCam.orbit( dx, dy );
				else this.input.addLook( dx * 1.6, dy * 1.6 ); // touch drag look (Player scales by 0.0022/px)

			}

		} );
		const end = ( e ) => { pointers.delete( e.pointerId ); };
		canvas.addEventListener( 'pointerup', end );
		canvas.addEventListener( 'pointercancel', end );
		canvas.addEventListener( 'wheel', ( e ) => {

			if ( this.mode === 'look' ) this.lookCam.zoom( 1 + Math.sign( e.deltaY ) * 0.09 );

		}, { passive: true } );

	}

	bindKeys() {

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.code === 'Digit1' ) this.setMode( 'look' );
			else if ( e.code === 'Digit2' ) this.setMode( 'walk' );
			else if ( e.code === 'Digit3' ) this.setMode( 'boat' );
			else if ( e.code === 'Digit4' ) this.setMode( 'dive' );
			else if ( e.code === 'KeyH' ) this.hud.toggle();
			// the game's own time key (App.js: T toggles the running day)
			else if ( e.code === 'KeyT' && this.envControls ) {

				this.envControls.setAdvance( ! this.envControls.state.advance );
				this.hud.refreshEnv();

			}

		} );

	}

	// ------------------------------------------------------------ the floating origin
	// When the player strays past SHIFT_AT, translate the whole local world
	// back by a multiple of SHIFT_STEP and refill the terrain window at the
	// new virtual offset. Virtual positions (local + offset) never change,
	// so the terrain underfoot is identical before and after.
	async maybeShift() {

		if ( this.shifting ) return;
		const p = this.player.position;
		if ( Math.abs( p.x ) < SHIFT_AT && Math.abs( p.z ) < SHIFT_AT ) return;
		const dx = Math.round( p.x / SHIFT_STEP ) * SHIFT_STEP;
		const dz = Math.round( p.z / SHIFT_STEP ) * SHIFT_STEP;
		if ( dx === 0 && dz === 0 ) return;
		this.shifting = true;
		try {

			const data = this.data;
			data.setOffset( data.offsetX + dx, data.offsetZ + dz );
			const missing = data.missingIslands();
			if ( missing.length ) {

				showLoader( 'Raising new islands…' );
				await nextFrame();
				for ( const desc of missing ) await data.generateIslandAsync( desc, ( p ) => { if ( p.label ) showLoader( p.label + '…' ); } );

			}
			data.refill();
			this.refreshTerrainGPU();

			// translate every local-space state by -delta
			const sub = ( v ) => { v.x -= dx; v.z -= dz; };
			sub( this.player.position );
			sub( this.camera.position );
			sub( this.boatCtl.position );
			sub( this.boatCtl.mooring.anchor );
			if ( this.boatCtl.bowWorld ) sub( this.boatCtl.bowWorld );
			if ( this.boatCtl.sternWorld ) sub( this.boatCtl.sternWorld );
			sub( this.lookCam.target );
			sub( this.lookCam.pos );
			this.boatCtl.apply(); // re-sync the model group to the shifted physics state
			this.recentreShoreSim();
			this.rebuildBreakers();
			hideLoader();

		} finally {

			this.shifting = false;

		}

	}

	// push the refilled window into the EXISTING TerrainGPU textures (the
	// terrain mesh, water and shore shaders all sample these — no material
	// or mesh rebuild needed; Terrain's CDLOD bounds read the provider live)
	refreshTerrainGPU() {

		const tg = this.terrainGPU, data = this.data;
		tg.heightTexture.upload( packHeightTexels( data ) );
		const maps = bakeTerrainMaps( data );
		tg.normalTexture.upload( maps.normal );
		generateMipmaps( tg.normalTexture );
		tg.splatTexture.upload( maps.splat );
		generateMipmaps( tg.splatTexture );
		const sh = buildShadowHeights( data, 4 );
		sh.levels.forEach( ( l, i ) => tg.shadowHeightTexture.upload( l.data, { mip: i, width: l.width, height: l.height } ) );
		tg.shadowTexel = sh.texel;
		tg.maxHeight = sh.maxHeight;
		tg.setShoreField( computeShoreField( data, { res: 512, swellDir: [ WORLD.swellDir.x, WORLD.swellDir.y ] } ) );

	}

	recentreShoreSim() {

		const c = this.player.position;
		const size = this.shoreSim.uSize.value;
		this.shoreSim.uMin.value.set( c.x - size / 2, c.z - size / 2 );
		this.shore.buildDirTexture( { min: new Vector2( c.x - size / 2, c.z - size / 2 ), size } );

	}

	// Keep the surf-sim window centred near the player: the window's edge
	// is where the sim's treatment of the water ends, so it must never
	// sit in the shallows being looked at (at the old fixed 560 m window
	// it drew a hard rectangle in the spawn bay — see the ShoreSim
	// construction note). Recentring restarts the foam state (it rebuilds
	// within a few seconds of surf) and rebuilds the direction texture;
	// the 200 m deadband keeps that rare. Runs on the 0.5 s check tick.
	maybeFollowShoreSim() {

		if ( ! this.shoreSim || this.shifting ) return;
		const size = this.shoreSim.uSize.value;
		const cx = this.shoreSim.uMin.value.x + size / 2;
		const cz = this.shoreSim.uMin.value.y + size / 2;
		const p = this.player.position;
		if ( Math.hypot( p.x - cx, p.z - cz ) > 200 ) this.recentreShoreSim();

	}

	rebuildBreakers() {

		const old = this.breakers;
		this.scene.remove( old.mesh );
		this.breakers = new Breakers( this.renderer, { surface: this.surface, shore: this.shore, terrainData: this.data, sky: this.sky, spray: this.spray, clouds: this.clouds } );
		this.scene.add( this.breakers.mesh );

	}

	// ------------------------------------------------------------ sun (the game's own wiring, from App.js)
	updateSun() {

		const s = this.settings;
		const dir = sunDirectionFromTime( s.timeOfDay ).applyAxisAngle( _up, MathUtils.degToRad( s.sunAzimuth || 0 ) );
		this.atmosphere.sunDir.value.copy( dir );
		const night = MathUtils.smoothstep( - dir.y, 0.02, 0.18 );
		G.night.value = night;
		this.sky.starIntensity.value = night;
		const moon = new Vector3( - dir.x, Math.abs( dir.y ) * 0.8 + 0.25, - dir.z ).normalize();
		this.sky.moonDir.value.copy( moon );
		const light = dir.y > - 0.07 ? dir : moon;
		G.sunDir.value.copy( light );

	}

	applyAtmosphereReadback() {

		const a = this.atmosphere;
		if ( ! a.sunTransmittance ) return;
		const sunTrue = a.sunDir.value;
		const sunUp = sunTrue.y > - 0.07;
		const T = a.sunTransmittance;
		const horizonFade = MathUtils.smoothstep( sunTrue.y, - 0.03, 0.02 );
		let c;
		if ( sunUp ) c = new Color( T[ 0 ], T[ 1 ], T[ 2 ] ).multiplyScalar( SUN_ILLUMINANCE * horizonFade );
		else c = new Color( 0.6, 0.7, 1.0 ).multiplyScalar( 0.12 * G.night.value );
		G.sunColor.value.copy( c );
		const irr = a.skyIrradiance;
		const nightAmb = 0.012 * G.night.value;
		G.skyIrradiance.value.setRGB( irr[ 0 ] + nightAmb * 0.6, irr[ 1 ] + nightAmb * 0.7, irr[ 2 ] + nightAmb );
		G.horizonColor.value.setRGB( a.horizon[ 0 ], a.horizon[ 1 ], a.horizon[ 2 ] );

	}

	// ------------------------------------------------------------ frame (order follows App._frame)
	frame( dt ) {

		if ( this.paused ) return;
		const { engine, camera } = this;
		GPU.beginFrame();
		FrameUniforms.fields.frameIndex.value = GPU.frame;
		G.dt.value = dt;
		G.time.value += dt;
		this.envControls.advanceTime( dt ); // the day/night cycle (wraps at 24 h)

		// boat physics first so the cameras follow this frame's pose (App.js)
		this.boatCtl.update( dt );
		this.boatSpray.update( dt );
		this.wake.update( dt );
		if ( this.mode === 'look' ) {

			const target = this.player.mode === 'boat' || this.player.mode === 'deck' ? this.boat.group.position : this.player.position;
			this.lookCam.update( dt, target, camera, ( x, z ) => this.data.heightAt( x, z ) );

		} else {

			this.player.update( dt );
			this.applyStickSpeedCap();

		}
		this.input.endFrame();

		this.updateSun();
		this.atmosphere.update( dt, camera.position.y );
		this.applyAtmosphereReadback();

		this.fft.update( dt );
		this.seaDetail.update( dt );
		this.query.setCamera( camera.position.x, camera.position.z );
		this.boatCtl.queueQueries();
		this.query.update();
		if ( this.query.cpuValid ) {

			const h0 = this.query.cpu[ 0 ];
			const h = Number.isFinite( h0 ) ? h0 : this.camWaterH;
			this.camWaterH = h;
			G.cameraWaterHeight.value = h;
			G.cameraUnderwater.value = camera.position.y < h ? 1 : 0;

		}
		if ( this.caustics ) this.caustics.update();
		this.shoreSim.update();
		if ( this.underwaterLighting ) this.underwaterLighting.update( camera );
		this.breakers.update( camera );
		this.spray.update();
		if ( this.clouds ) this.clouds.update( dt, camera );
		if ( this.environment ) this.environment.update( dt );
