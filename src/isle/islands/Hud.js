// Hud.js — island29's control scheme, driving tidewater's player (my code).
//
// island29's scheme (its App.tsx / Hud.tsx):
//   - a small round menu button, top-left, hides/shows the HUD; the HUD is
//     hidden by default and the play controls never hide.
//   - mode buttons: Look / Walk / Boat (island29 also has Dive — excluded
//     here, nothing underwater is in this project).
//   - bottom-left analog stick in walk mode; speed follows the push.
//   - hold-to-run button (island29's run is a hold/toggle in its HUD; here
//     it is a hold button, per the brief).
//   - boat mode: hold pads — steer ◀ ▶ bottom-left, throttle ▲ ▼ bottom-right.
//   - touch drag orbits the view, pinch zooms; desktop WASD + mouse, with
//     the game's own keys (E interact, V boat camera, Space jump/swim up).
//
// tidewater's Player reads a tidewater Input (keys/locked mouse). The
// InputFacade below presents exactly that interface: real keyboard/mouse
// from the game's Input, plus synthetic keys/look injected by the touch
// HUD. The analog magnitude cannot pass through boolean keys, so the
// facade also exposes stickMag and the app caps the walker's horizontal
// speed proportionally after Player.update (see main.js) — direction and
// all physics stay the game's.

import * as THREE from '../engine/index.js';
import { ENV_SLIDERS, SEA_PRESET_ORDER, TIME_SPEED_STEPS, formatTimeOfDay } from './EnvControls.js';

const domEl = ( html ) => {

	const t = document.createElement( 'template' );
	t.innerHTML = html.trim();
	return t.content.firstElementChild;

};

export class InputFacade {

	constructor( real ) {

		this.real = real;
		this.held = new Set(); // synthetic keys currently held (touch)
		this.taps = new Set(); // synthetic one-frame key hits
		this.lookX = 0;
		this.lookY = 0;
		this.wheelAcc = 0;
		this.stickMag = 0; // 0..1 analog magnitude (0 when the stick is centred)
		this.stickActive = false;

	}

	down( code ) {

		return this.real.down( code ) || this.held.has( code );

	}

	hit( code ) {

		if ( this.taps.has( code ) ) { this.taps.delete( code ); return true; }
		return this.real.hit( code );

	}

	// touch hold button down/up
	setHeld( code, on ) {

		if ( on ) this.held.add( code ); else this.held.delete( code );

	}

	// one-frame tap (prompt button, mode shortcuts)
	tap( code ) {

		this.taps.add( code );

	}

	addLook( x, y ) {

		this.lookX += x;
		this.lookY += y;

	}

	addWheel( w ) {

		this.wheelAcc += w;

	}

	consumeLook() {

		const l = this.real.consumeLook();
		l.x += this.lookX;
		l.y += this.lookY;
		this.lookX = 0;
		this.lookY = 0;
		return l;

	}

	consumeWheel() {

		const w = this.real.consumeWheel() + this.wheelAcc;
		this.wheelAcc = 0;
		return w;

	}

	endFrame() {

		this.taps.clear();
		this.real.endFrame();

	}

	// analog stick vector: x right, y forward, each -1..1 (screen-up = forward)
	setStick( x, y ) {

		const mag = Math.hypot( x, y );
		this.stickActive = mag > 0.16;
		this.stickMag = Math.min( 1, mag );
		this.setHeld( 'KeyW', y > 0.35 );
		this.setHeld( 'KeyS', y < - 0.35 );
		this.setHeld( 'KeyD', x > 0.35 );
		this.setHeld( 'KeyA', x < - 0.35 );

	}

	clearStick() {

		this.stickActive = false;
		this.stickMag = 0;
		for ( const c of [ 'KeyW', 'KeyS', 'KeyD', 'KeyA' ] ) this.held.delete( c );

	}

}

// ---------------------------------------------------------------- Look camera
// Orbit/zoom camera for Look mode (island29's survey mode): damped orbit
// around a target that follows the player, drag to orbit, pinch/wheel zoom.
export class LookCam {

	constructor() {

		this.yaw = Math.PI; // looking toward +z (the swell side) initially
		this.pitch = 0.32;
		this.dist = 60;
		this.target = new THREE.Vector3();
		this.pos = new THREE.Vector3();
		this.init = false;

	}

	orbit( dx, dy ) {

		this.yaw -= dx * 0.005;
		this.pitch = THREE.MathUtils.clamp( this.pitch + dy * 0.005, - 0.05, 1.35 );

	}

	zoom( f ) {

		this.dist = THREE.MathUtils.clamp( this.dist * f, 4, 4000 );

	}

	update( dt, targetPos, camera, groundAt ) {

		this.target.lerp( targetPos, this.init ? 1 - Math.exp( - dt * 5 ) : 1 );
		this.init = true;
		const cp = Math.cos( this.pitch ), sp = Math.sin( this.pitch );
		const want = new THREE.Vector3(
			this.target.x + Math.sin( this.yaw ) * cp * this.dist,
			this.target.y + sp * this.dist,
			this.target.z + Math.cos( this.yaw ) * cp * this.dist,
		);
		// never sink the look camera under the terrain or the sea surface
		// (clamp the goal, then clamp the lerped result too, so the camera
		// can never dip through a hill while the damping catches up)
		const g = groundAt ? groundAt( want.x, want.z ) : - 40;
		want.y = Math.max( want.y, g + 1.2, 0.8 );
		this.pos.lerp( want, 1 - Math.exp( - dt * 8 ) );
		if ( groundAt ) this.pos.y = Math.max( this.pos.y, groundAt( this.pos.x, this.pos.z ) + 1.2, 0.8 );
		camera.position.copy( this.pos );
		camera.lookAt( this.target.x, this.target.y + 1.5, this.target.z );

	}

}

// ---------------------------------------------------------------- HUD
export class Hud {

	// callbacks: { onMode(mode), onQuality(name), facade, env }
	// env (optional) is an EnvControls instance (islands/EnvControls.js):
	// the sun/time, clouds and weather controls bind to it.
	constructor( { facade, onMode, onQuality, env } ) {

		this.facade = facade;
		this.onMode = onMode;
		this.onQuality = onQuality;
		this.env = env || null;
		this._sliders = []; // { def, input, valEl } for every env slider row
		this._timeDrag = false;
		this.uiMode = 'walk';
		this.quality = null;

		const el = ( html ) => {

			const t = document.createElement( 'template' );
			t.innerHTML = html.trim();
			return t.content.firstElementChild;

		};

		// round menu button, top-left — always visible (island29's pattern)
		this.menuBtn = el( `<button id="menu-btn" aria-label="Show or hide the interface">☰</button>` );
		document.body.appendChild( this.menuBtn );

		this.root = el( `<div id="hud" style="display:none">
			<div class="hud-top">
				<div class="hud-modes">
					<button data-mode="look">Look</button>
					<button data-mode="walk" class="on">Walk</button>
					<button data-mode="boat">Boat</button>
					<button data-mode="dive">Dive</button>
				</div>
			</div>
			<div class="hud-side">
				<div class="hud-group-label">Quality</div>
				<div class="hud-quality">
					<button data-q="light">Light</button>
					<button data-q="balanced">Balanced</button>
					<button data-q="high">High</button>
				</div>
				<div class="hud-note" id="hud-quality-note"></div>
				<div id="hud-env"></div>
				<div class="hud-hint">WASD move · mouse look · E use · Space jump / swim up · Shift run<br>1 Look · 2 Walk · 3 Boat · 4 Dive · M map · H interface · V boat camera · T run/pause time</div>
			</div>
		</div>` );
		document.body.appendChild( this.root );
		if ( this.env ) {

			this.envHost = this.root.querySelector( '#hud-env' );
			this.buildEnv();

		}

		this.prompt = el( `<button id="hud-prompt" style="display:none"></button>` );
		document.body.appendChild( this.prompt );
		this.gauge = el( `<div id="hud-gauge" style="display:none"><strong>0.0</strong><small>kn</small><span class="hud-thr"><i></i></span></div>` );
		document.body.appendChild( this.gauge );

		// play controls — never hidden with the HUD
		this.joy = el( `<div id="joystick"><div class="joy-knob"></div></div>` );
		document.body.appendChild( this.joy );
		this.runBtn = el( `<button id="btn-run" aria-label="Hold to run">»</button>` );
		document.body.appendChild( this.runBtn );
		this.boatPads = el( `<div id="boat-pads" style="display:none">
			<div class="pad-left">
				<button data-k="KeyA" aria-label="Steer left">◀</button>
				<button data-k="KeyD" aria-label="Steer right">▶</button>
			</div>
			<div class="pad-right">
				<button data-k="KeyW" aria-label="Throttle ahead">▲</button>
				<button data-k="KeyS" aria-label="Throttle astern">▼</button>
			</div>
		</div>` );
		document.body.appendChild( this.boatPads );

		this.menuBtn.addEventListener( 'click', () => this.toggle() );
		this.root.querySelectorAll( '[data-mode]' ).forEach( ( b ) =>
			b.addEventListener( 'click', () => this.onMode( b.dataset.mode ) ) );
		this.root.querySelectorAll( '[data-q]' ).forEach( ( b ) =>
			b.addEventListener( 'click', () => this.onQuality( b.dataset.q ) ) );
		this.prompt.addEventListener( 'click', () => this.facade.tap( 'KeyE' ) );

		// hold buttons (run + boat pads): pointer down holds the key
		const hold = ( node, code ) => {

			const on = ( e ) => { e.preventDefault(); node.setPointerCapture?.( e.pointerId ); this.facade.setHeld( code, true ); node.classList.add( 'held' ); };
			const off = () => { this.facade.setHeld( code, false ); node.classList.remove( 'held' ); };
			node.addEventListener( 'pointerdown', on );
			node.addEventListener( 'pointerup', off );
			node.addEventListener( 'pointercancel', off );
			node.addEventListener( 'lostpointercapture', off );

		};
		hold( this.runBtn, 'ShiftLeft' );
		this.boatPads.querySelectorAll( '[data-k]' ).forEach( ( b ) => hold( b, b.dataset.k ) );

		this.bindJoystick();

	}

	toggle() {

		const open = this.root.style.display === 'none';
		this.root.style.display = open ? '' : 'none';
		this.menuBtn.textContent = open ? '✕' : '☰';

	}

	setVisible( v ) {

		this.root.style.display = v ? '' : 'none';
		this.menuBtn.textContent = v ? '✕' : '☰';

	}

	bindJoystick() {

		const joy = this.joy, knob = joy.querySelector( '.joy-knob' );
		let id = null;
		const setKnob = ( dx, dy ) => { knob.style.transform = `translate( calc( -50% + ${ dx }px ), calc( -50% + ${ dy }px ) )`; };
		joy.addEventListener( 'pointerdown', ( e ) => { id = e.pointerId; joy.setPointerCapture( id ); this.moveStick( e ); } );
		joy.addEventListener( 'pointermove', ( e ) => { if ( e.pointerId === id ) this.moveStick( e ); } );
		const end = ( e ) => {

			if ( e.pointerId !== id ) return;
			id = null;
			setKnob( 0, 0 );
			this.facade.clearStick();

		};
		joy.addEventListener( 'pointerup', end );
		joy.addEventListener( 'pointercancel', end );
		this._setKnob = setKnob;

	}

	moveStick( e ) {

		const r = this.joy.getBoundingClientRect();
		let dx = e.clientX - ( r.left + r.width / 2 ), dy = e.clientY - ( r.top + r.height / 2 );
		const max = r.width / 2;
		const len = Math.hypot( dx, dy );
		if ( len > max ) { dx *= max / len; dy *= max / len; }
		this._setKnob( dx, dy );
		// screen y down -> forward is -dy
		this.facade.setStick( dx / max, - dy / max );

	}

	// per-frame: playerMode is tidewater's ('walk'|'swim'|'deck'|'boat') or 'look'
	setState( playerMode, prompt, boatInfo ) {

		const ui = playerMode === 'look' ? 'look' : playerMode === 'boat' ? 'boat' : 'walk';
		if ( ui !== this.uiMode ) {

			this.uiMode = ui;
			this.root.querySelectorAll( '[data-mode]' ).forEach( ( b ) => b.classList.toggle( 'on', b.dataset.mode === ui ) );

		}
		const onFoot = ui === 'walk';
		this.joy.style.display = onFoot ? '' : 'none';
		this.runBtn.style.display = onFoot ? '' : 'none';
		this.boatPads.style.display = ui === 'boat' ? '' : 'none';
		this.gauge.style.display = ui === 'boat' ? '' : 'none';
		if ( prompt && prompt.text ) {

			this.prompt.style.display = '';
			this.prompt.textContent = prompt.key + ' · ' + prompt.text;

		} else this.prompt.style.display = 'none';
		if ( ui === 'boat' && boatInfo ) {

			this.gauge.querySelector( 'strong' ).textContent = boatInfo.kn.toFixed( 1 );
			const i = this.gauge.querySelector( '.hud-thr i' );
			const t = THREE.MathUtils.clamp( boatInfo.throttle, - 1, 1 );
			i.style.left = t < 0 ? ( 50 + t * 50 ) + '%' : '50%';
			i.style.width = Math.abs( t ) * 50 + '%';

		}

	}

	// ------------------------------------------------ environment controls
	// Sun & time / Clouds / Weather sections in the menu panel, bound to
	// the EnvControls instance: every input writes through to the live
	// systems (see EnvControls.js). Same visual language as Quality.
	buildEnv() {

		const controls = this.env;
		const host = this.envHost;
		const section = ( label ) => {

			const d = domEl( `<div><div class="hud-group-label">${ label }</div></div>` );
			host.appendChild( d );
			return d;

		};
		const byKey = ( k ) => ENV_SLIDERS.find( ( s ) => s.key === k );

		// ---- Sun & time: the time slider, the cycle play/pause + speed
		// steps, then tidewater's own sun-azimuth slider
		const sun = section( 'Sun & time' );
		this._addSlider( sun, byKey( 'time' ) );
		this.advanceBtn = domEl( `<button class="hud-wide-btn"></button>` );
		sun.appendChild( this.advanceBtn );
		this.advanceBtn.addEventListener( 'click', () => {

			controls.setAdvance( ! controls.state.advance );
			this.refreshEnv();

		} );
		const speeds = domEl( `<div class="hud-speed"></div>` );
		sun.appendChild( speeds );
		this.speedBtns = TIME_SPEED_STEPS.map( ( s ) => {

			const b = domEl( `<button>${ s.label }</button>` );
			b.addEventListener( 'click', () => {

				controls.setSpeed( s.value );
				this.refreshEnv();

			} );
			speeds.appendChild( b );
			return { value: s.value, btn: b };

		} );
		this._addSlider( sun, byKey( 'azimuth' ) );

		// ---- Clouds
		const cl = section( 'Clouds' );
		for ( const def of ENV_SLIDERS.filter( ( s ) => s.group === 'clouds' ) ) this._addSlider( cl, def );

		// ---- Weather: tidewater's four sea-state presets + its sliders
		const w = section( 'Weather' );
		const presets = domEl( `<div class="hud-presets"></div>` );
		w.appendChild( presets );
		this.presetBtns = SEA_PRESET_ORDER.map( ( name ) => {

			const b = domEl( `<button>${ name }</button>` );
			b.addEventListener( 'click', () => {

				controls.applyPreset( name );
				this.refreshEnv();

			} );
			presets.appendChild( b );
			return { name, btn: b };

		} );
		for ( const def of ENV_SLIDERS.filter( ( s ) => s.group === 'weather' ) ) {

			// AppUI adds the caustics slider only when the app has caustics
			if ( def.key === 'caustics' && ! controls.systems.caustics ) continue;
			this._addSlider( w, def );

		}
		this.refreshEnv();

	}

	_addSlider( parent, def ) {

		const controls = this.env;
		const row = domEl( `<div class="hud-slider"><label>${ def.label }<span class="hud-val"></span></label><input type="range"></div>` );
		const input = row.querySelector( 'input' );
		const valEl = row.querySelector( '.hud-val' );
		if ( def.log ) { input.min = 0; input.max = 1000; input.step = 1; }
		else { input.min = def.min; input.max = def.max; input.step = def.step; }
		const rec = { def, input, valEl };
		input.addEventListener( 'input', () => {

			const v = this._readSlider( rec );
			controls.setValue( def.key, v );
			valEl.textContent = this._fmtVal( def, v );
			this._syncPresetBtns(); // a manual weather move clears the preset

		} );
		if ( def.key === 'time' ) {

			// while the user drags the time slider, the per-frame sync
			// (setEnvTime) must not fight the drag
			input.addEventListener( 'pointerdown', () => { this._timeDrag = true; } );
			window.addEventListener( 'pointerup', () => { this._timeDrag = false; } );

		}
		parent.appendChild( row );
		this._sliders.push( rec );
		this._writeSlider( rec, controls.state[ def.key ] );
		return rec;

	}

	_readSlider( rec ) {

		const { def, input } = rec;
		if ( def.log ) {

			const t = Number( input.value ) / 1000;
			return Math.exp( Math.log( def.min ) + ( Math.log( def.max ) - Math.log( def.min ) ) * t );

		}
		return Number( input.value );

	}

	_writeSlider( rec, v ) {

		const { def, input, valEl } = rec;
		if ( def.log ) input.value = Math.round( 1000 * ( Math.log( v ) - Math.log( def.min ) ) / ( Math.log( def.max ) - Math.log( def.min ) ) );
		else input.value = v;
		valEl.textContent = this._fmtVal( def, v );

	}

	_fmtVal( def, v ) {

		if ( def.fmt === 'time' ) return formatTimeOfDay( v );
		if ( def.fmt === 'percent' ) return Math.round( v * 100 ) + '%';
		if ( def.fmt === 'waveHeight' ) return ( v * 2 ).toFixed( 2 ) + ' m'; // AppUI's own format
		const dec = def.step >= 1 ? 0 : def.step >= 0.1 ? 1 : 2;
		return v.toFixed( dec ) + ( def.unit ? ' ' + def.unit : '' );

	}

	_syncPresetBtns() {

		if ( ! this.presetBtns ) return;
		for ( const p of this.presetBtns ) p.btn.classList.toggle( 'on', this.env.state.preset === p.name );

	}

	// re-sync every env control's DOM from the control state (after a
	// preset, a speed/advance change, or the T key)
	refreshEnv() {

		if ( ! this.env ) return;
		const st = this.env.state;
		for ( const rec of this._sliders ) this._writeSlider( rec, st[ rec.def.key ] );
		this._syncPresetBtns();
		if ( this.advanceBtn ) {

			this.advanceBtn.textContent = st.advance ? '❚❚ Pause the day' : '▶ Run the day';
			this.advanceBtn.classList.toggle( 'on', st.advance );

		}
		if ( this.speedBtns ) for ( const s of this.speedBtns ) s.btn.classList.toggle( 'on', Math.abs( s.value - st.timeSpeed ) < 1e-9 );

	}

	// per-frame from the app: keep the time slider/readout following the
	// running cycle (skipped while the user is dragging it)
	setEnvTime( h ) {

		if ( ! this.env || this._timeDrag ) return;
		const rec = this._sliders.find( ( r ) => r.def.key === 'time' );
		if ( rec && rec.valEl.textContent !== formatTimeOfDay( h ) ) this._writeSlider( rec, h );

	}

	setQualityUI( name, note ) {

		this.quality = name;
		this.root.querySelectorAll( '[data-q]' ).forEach( ( b ) => b.classList.toggle( 'on', b.dataset.q === name ) );
		const n = document.getElementById( 'hud-quality-note' );
		if ( n ) n.textContent = note || '';

	}

}
