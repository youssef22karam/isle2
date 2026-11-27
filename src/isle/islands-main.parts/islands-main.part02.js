		this.oceanLOD.update( camera );
		this.terrain.update( camera );
		this.boat.update( dt );

		// HUD state + the endless world
		const uiMode = this.mode === 'look' ? 'look' : this.player.mode;
		this.hud.setState( uiMode, this.mode === 'look' ? null : this.player.prompt, {
			kn: this.boatCtl.velocity.length() * 1.94384,
			throttle: this.boatCtl.throttle,
		} );
		this.hud.setEnvTime( this.settings.timeOfDay );
		this._shiftCheckT -= dt;
		this._tickT = ( this._tickT || 0 ) - dt;
		if ( this._tickT <= 0 && this.hooks && this.hooks.onTick ) { this._tickT = 0.2; this.hooks.onTick( this.snapshot() ); }
		if ( this._shiftCheckT <= 0 ) { this._shiftCheckT = 0.5; this.maybeShift(); this.maybeFollowShoreSim(); }

		setFrameCamera( camera, engine.width, engine.height );
		this.shadows.render( this.scene, engine.meshRenderer, this.shadows.update( camera, G.sunDir.value ) );
		this.sceneRenderer.render();
		const view = GPU.context.getCurrentTexture().createView();
		this.present.render( { colorViews: [ view ], clear: [ 0, 0, 0, 1 ] } );
		GPU.submit();

	}

	// ------------------------------------------------------------ shell API (React overlay: map, teleport, dive)
	pause() { this.paused = true; }
	resume() { this.paused = false; }

	// a light per-tick state record for the overlay (local + virtual position, view heading, water)
	snapshot() {

		const p = this.player, d = this.data;
		const onBoat = p.mode === 'boat' || p.mode === 'deck';
		const pos = onBoat ? this.boatCtl.position : p.position;
		const e = this.camera.matrixWorld.elements;
		const fl = Math.hypot( e[ 8 ], e[ 10 ] ) || 1;
		const w = d.waterAt( pos.x, pos.z );
		return {
			x: pos.x, z: pos.z, vx: pos.x + d.offsetX, vz: pos.z + d.offsetZ,
			dirX: - e[ 8 ] / fl, dirZ: - e[ 10 ] / fl,
			mode: this.mode === 'look' ? 'look' : p.mode, body: w.body, depth: w.depth, shifting: this.shifting,
		};

	}

	// nearest water at least minDepth deep within radius (local coords), ring search
	findWaterNear( x, z, minDepth = 1, radius = 60, inlandOnly = false ) {

		const d = this.data;
		for ( let r = 0; r <= radius; r += 3 ) {

			const n = Math.max( 1, Math.round( ( 2 * Math.PI * r ) / 3 ) );
			for ( let i = 0; i < n; i ++ ) {

				const a = ( i / n ) * Math.PI * 2;
				const px = x + Math.cos( a ) * r, pz = z + Math.sin( a ) * r;
				const w = d.waterAt( px, pz );
				if ( w.depth < minDepth || w.body === 'land' ) continue;
				if ( inlandOnly && w.body === 'sea' ) continue;
				return { x: px, z: pz, depth: w.depth, body: w.body };

			}

		}
		return null;

	}

	// where a dive starts: right here when in water, else the nearest water within ~45 m
	diveSpot() {

		const s = this.snapshot();
		const w = this.data.waterAt( s.x, s.z );
		if ( w.depth >= 1.0 && w.body !== 'land' ) return { x: s.x, z: s.z, body: w.body, depth: w.depth, dirX: s.dirX, dirZ: s.dirZ };
		const near = this.findWaterNear( s.x, s.z, 1.2, 45 );
		return near ? { ...near, dirX: s.dirX, dirZ: s.dirZ } : null;

	}

	// back from a dive: the swimmer comes up at local (x, z), facing dir
	surfaceAt( x, z, dir ) {

		const p = this.player;
		if ( p.mode === 'boat' ) { p.leaveHelm(); p.exitBoat(); } else if ( p.mode === 'deck' ) p.exitBoat();
		this.mode = 'walk';
		const h = this.data.heightAt( x, z );
		p.position.set( x, h > 0 ? h : Math.max( h, - 1.3 ), z );
		if ( p.velocity ) p.velocity.set( 0, 0, 0 );
		if ( dir && typeof p.yaw === 'number' ) p.yaw = Math.atan2( - dir.x, - dir.z );
		this.camera.position.set( x, Math.max( h, 0 ) + 1.6, z );
		this.recentreShoreSim();

	}

	// teleport to virtual (vx, vz): shift the window there, raise missing islands, place the player
	async teleport( vx, vz, opts = {} ) {

		if ( this.shifting ) return false;
		this.shifting = true;
		try {

			const p = this.player, data = this.data;
			if ( p.mode === 'boat' ) { p.leaveHelm(); p.exitBoat(); } else if ( p.mode === 'deck' ) p.exitBoat();
			this.mode = 'walk';
			showLoader( opts.label || 'Travelling…' );
			await nextFrame();
			const ox = Math.round( vx / SHIFT_STEP ) * SHIFT_STEP, oz = Math.round( vz / SHIFT_STEP ) * SHIFT_STEP;
			const dx = ox - data.offsetX, dz = oz - data.offsetZ;
			data.setOffset( ox, oz );
			for ( const desc of data.missingIslands() ) await data.generateIslandAsync( desc, ( q ) => { if ( q.label ) showLoader( q.label + '…' ); } );
			data.refill();
			this.refreshTerrainGPU();
			const b = this.boatCtl;
			const sub = ( v ) => { if ( v ) { v.x -= dx; v.z -= dz; } };
			sub( b.position ); sub( b.mooring && b.mooring.anchor ); sub( b.bowWorld ); sub( b.sternWorld );
			const lx = vx - ox, lz = vz - oz;
			// the boat comes along when the jump leaves it far away
			if ( Math.hypot( b.position.x - lx, b.position.z - lz ) > 500 ) {

				const spot = this.findWaterNear( lx, lz, 3.2, 420 );
				if ( spot ) {

					const mx = spot.x - b.position.x, mz = spot.z - b.position.z;
					for ( const v of [ b.position, b.mooring && b.mooring.anchor, b.bowWorld, b.sternWorld ] ) if ( v ) { v.x += mx; v.z += mz; }
					if ( b.velocity ) b.velocity.set( 0, 0, 0 );

				}

			}
			b.apply();
			const h = data.heightAt( lx, lz );
			p.position.set( lx, h > 0 ? h : Math.max( h, - 1.3 ), lz );
			if ( p.velocity ) p.velocity.set( 0, 0, 0 );
			if ( typeof opts.yaw === 'number' && typeof p.yaw === 'number' ) p.yaw = opts.yaw;
			if ( typeof p.pitch === 'number' ) p.pitch = - 0.06;
			this.camera.position.set( lx, Math.max( h, 0 ) + 1.7, lz );
			this.lookCam.init = false;
			this.recentreShoreSim();
			this.rebuildBreakers();
			hideLoader();
			return true;

		} catch ( e ) {

			console.error( e );
			hideLoader();
			return false;

		} finally {

			this.shifting = false;

		}

	}

	// the k-th nearest distinct lake / river / swamp / beach of the generated islands (virtual
	// coords), as a standing spot on its shore facing the water. Skips the one the player is at.
	findFeature( kind, k = 0 ) {

		const s = this.snapshot();
		const cands = [];
		for ( const { desc, grid } of this.data.islands.values() ) {

			const { N, cell, half, body, heights } = grid;
			const sd = kind === 'beach' ? seaDistance( grid ) : null;
			for ( let j = 2; j < N - 2; j += 2 ) for ( let i = 2; i < N - 2; i += 2 ) {

				const q = j * N + i, b = body[ q ], h = heights[ q ];
				let ok = false;
				if ( kind === 'lake' ) ok = b === 2 && h < - 3;
				else if ( kind === 'river' ) ok = b === 3 && h < - 1.2;
				else if ( kind === 'swamp' ) ok = b === 5 && h < - 0.3;
				else if ( kind === 'beach' ) ok = b === 0 && h > 0.35 && h < 1.4 && sd[ q ] < 40 &&
					Math.abs( heights[ q + 1 ] - heights[ q - 1 ] ) < cell * 0.16 && Math.abs( heights[ q + N ] - heights[ q - N ] ) < cell * 0.16;
				if ( ! ok ) continue;
				const vx = desc.cx - half + ( i + 0.5 ) * cell, vz = desc.cz - half + ( j + 0.5 ) * cell;
				const dist = Math.hypot( vx - s.vx, vz - s.vz );
				if ( dist < 140 ) continue;
				cands.push( { vx, vz, d: dist, grid, desc, i, j } );

			}

		}
		cands.sort( ( a, b ) => a.d - b.d );
		const picks = [];
		for ( const c of cands ) {

			if ( picks.some( ( p ) => Math.hypot( p.vx - c.vx, p.vz - c.vz ) < 280 ) ) continue;
			picks.push( c );
			if ( picks.length > k ) break;

		}
		if ( ! picks.length ) return null;
		return this.standSpot( kind, picks[ k % picks.length ] );

	}

	standSpot( kind, c ) {

		const { grid, desc, i, j } = c;
		const { N, cell, half, heights } = grid;
		const V = ( ii, jj ) => ( { vx: desc.cx - half + ( ii + 0.5 ) * cell, vz: desc.cz - half + ( jj + 0.5 ) * cell } );
		if ( kind === 'beach' ) {

			// face the sea (downhill); Player yaw convention: forward = ( -sin yaw, -cos yaw )
			const gx = heights[ j * N + i + 1 ] - heights[ j * N + i - 1 ], gz = heights[ ( j + 1 ) * N + i ] - heights[ ( j - 1 ) * N + i ];
			const l = Math.hypot( gx, gz ) || 1;
			const p = V( i, j );
			return { vx: p.vx, vz: p.vz, yaw: Math.atan2( gx / l, gz / l ), kind };

		}
		for ( let r = 1; r <= 16; r ++ ) {

			let best = null;
			for ( let dj = - r; dj <= r; dj ++ ) for ( let di = - r; di <= r; di ++ ) {

				if ( Math.max( Math.abs( di ), Math.abs( dj ) ) !== r ) continue;
				const ii = i + di, jj = j + dj;
				if ( ii < 1 || jj < 1 || ii >= N - 1 || jj >= N - 1 ) continue;
				const h = heights[ jj * N + ii ];
				if ( h > 0.25 && h < 8 ) { const dd = di * di + dj * dj + ( h > 3.5 ? 6 : 0 ); if ( ! best || dd < best.dd ) best = { ii, jj, dd }; }

			}
			if ( best ) {

				const ux = best.ii - i, uz = best.jj - j, l = Math.hypot( ux, uz ) || 1;
				const p = V( best.ii, best.jj );
				return { vx: p.vx + ( ux / l ) * cell * 0.3, vz: p.vz + ( uz / l ) * cell * 0.3, yaw: Math.atan2( ux / l, uz / l ), kind };

			}

		}
		const p = V( i, j );
		return { vx: p.vx, vz: p.vz, yaw: 0, kind };

	}

	// island29's analog rule — speed follows the push. tidewater's Player
	// reads boolean keys, so after its update we cap the walker's horizontal
	// speed at the stick's fraction of the mode's full speed (direction and
	// physics are untouched; desktop keys never trigger this).
	applyStickSpeedCap() {

		const f = this.input;
		if ( ! f.stickActive || f.stickMag >= 0.97 ) return;
		const p = this.player;
		if ( p.mode !== 'walk' && p.mode !== 'swim' ) return;
		const run = f.down( 'ShiftLeft' ) || f.down( 'ShiftRight' );
		const full = p.mode === 'swim' ? 2.9 : run ? 6.2 : 3.0; // Player's own speed constants
		const cap = full * f.stickMag;
		const hs = Math.hypot( p.velocity.x, p.velocity.z );
		if ( hs > cap && hs > 1e-4 ) {

			const s = cap / hs;
			p.velocity.x *= s;
			p.velocity.z *= s;

		}

	}

}

// ---------------------------------------------------------------- boot helpers
function nextFrame() {

	return new Promise( ( r ) => requestAnimationFrame( r ) );

}
function showLoader( msg ) {

	const l = document.getElementById( 'loader' );
	if ( l ) { l.style.display = ''; document.getElementById( 'loader-text' ).textContent = msg; }

}
function hideLoader() {

	const l = document.getElementById( 'loader' );
	if ( l ) l.style.display = 'none';

}

// ---------------------------------------------------------------- boot (called by the React shell)
let _booted = null;
export function bootIslands( container, hooks = {} ) {

	if ( _booted ) return _booted;
	const loaderText = document.getElementById( 'loader-text' );
	const app = new IslandsApp( container );
	app.hooks = hooks;
	window.__islands = app;
	_booted = app.init( ( msg ) => { if ( loaderText ) loaderText.textContent = msg; } ).then( () => {
		hideLoader();
		if ( hooks.onReady ) hooks.onReady( app );
		return app;
	} ).catch( ( err ) => {
		console.error( err );
		if ( loaderText ) {
			const msg = err && err.message ? err.message : String( err );
			const gpuFailure = ! navigator.gpu || /webgpu|adapter/i.test( msg );
			loaderText.innerHTML = 'Could not start.<br>' + msg +
				( gpuFailure ? '<br><br>This experience needs WebGPU (a recent Chrome/Edge, or Safari 26+).' : '' );
			loaderText.style.color = '#ffb4a2';
		}
		throw err;
	} );
	return _booted;

}
export { showLoader, hideLoader };
export { IslandsApp };
