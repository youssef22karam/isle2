	for ( var y = -1; y <= 1; y++ ) { for ( var x = -1; x <= 1; x++ ) {
		let dz = textureLoad( traceDepth, clamp( vec2i( tp ) + vec2i( x, y ), vec2i( 0 ), tmax ), 0 );
		let key = select( 1e9, dz.x, dz.y > 0.15 );
		if ( key < best.x ) { best = vec3f( key, dz.xy ); }
	} }
	if ( best.x > 1e8 ) {
		best = vec3f( 0.0, textureLoad( traceDepth, vec2i( tp ), 0 ).xy );
	}
	textureStore( motionOut, tp, vec4f( best.yz, 0.0, 1.0 ) );
}` );

		// range (min, max) of this frame's composited samples in the 3x3 blocks around each block
		const box = K( 'Clouds Box', { traceTex: { texture: this.traceTex }, highTrace: { texture: this.highTrace }, minOut: { storageTexture: this.boxMin }, maxOut: { storageTexture: this.boxMax } }, /* wgsl */`${ MAIN } {
	let tp = vec2i( gid.xy );
	if ( cloudsOutside( gid.xy ) ) { return; }
	let tmax = vec2i( cloudsParams.traceSize ) - 1;
	var lo = vec4f( 1e4 ); var hi = vec4f( -1e4 );
	for ( var y = -1; y <= 1; y++ ) { for ( var x = -1; x <= 1; x++ ) {
		let q = clamp( tp + vec2i( x, y ), vec2i( 0 ), tmax );
		let c = clOver( textureLoad( traceTex, q, 0 ), textureLoad( highTrace, q, 0 ) );
		lo = min( lo, c );
		hi = max( hi, c );
	} }
	textureStore( minOut, tp, lo );
	textureStore( maxOut, tp, hi );
}` );

		// ---- resolve: reproject the history, refresh the traced pixels
		const resolve = ( src, dst ) => K( 'Clouds Resolve', {
			motionTex: { texture: this.motionTex }, traceTex: { texture: this.traceTex }, highTrace: { texture: this.highTrace },
			boxMin: { texture: this.boxMin }, boxMax: { texture: this.boxMax }, srcHistory: { texture: src }, dstHistory: { storageTexture: dst },
		}, /* wgsl */`
${ catmullRomWGSL( 'historyCatmullRom', 'srcHistory' ) }
// this frame's samples upsampled (they sit at the slot of each block)
fn upsampled( p: vec2u ) -> vec4f {
	let suv = ( ( vec2f( p ) - cloudsTrace.slot ) / 4.0 + 0.5 ) / cloudsParams.traceSize;
	return clOver( textureSampleLevel( traceTex, smpLinearClamp, suv, 0.0 ), textureSampleLevel( highTrace, smpLinearClamp, suv, 0.0 ) );
}
fn b2( a: f32, b: f32 ) -> f32 { return abs( a - b ) * 2.0 + b; }
${ MAIN } {
	let p = gid.xy;
	if ( p.x >= u32( cloudsParams.viewSize.x ) || p.y >= u32( cloudsParams.viewSize.y ) ) { return; }
	let uv = ( vec2f( p ) + 0.5 ) / cloudsParams.viewSize;
	let rd = cloudsViewDir( uv );
	if ( rd.y < -0.06 ) { return; }

	let tp = p / 4u;
	let fresh = ( p.x % 4u ) == u32( cloudsTrace.slot.x ) && ( p.y % 4u ) == u32( cloudsTrace.slot.y );
	let dz = textureLoad( motionTex, vec2i( tp ), 0 );
	// where was this cloud point last frame (camera motion and wind drift): cumulus, or the high
	// layers where there is no cumulus in front
	let T = cloudsTrace;
	let pdC = normalize( rd * dz.x + T.camDelta );
	let pdH = normalize( rd * cloudsShell( cloudsParams.camY, rd, cloudsParams.cirrusAlt ) + T.camDeltaHi );
	let pd = select( pdH, pdC, dz.y > 0.3 );
	let puv = mix( cloudsProject( pdH, T.prevRight, T.prevUp, T.prevFwd, T.prevTan ), cloudsProject( pdC, T.prevRight, T.prevUp, T.prevFwd, T.prevTan ), smoothstep( 0.1, 0.5, dz.y ) );
	let valid = T.historyValid > 0.5 && dot( pd, T.prevFwd ) > 0.01 && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0 && pd.y > -0.05;
	var out = vec4f( 0.0, 0.0, 0.0, 1.0 );
	if ( rd.y > -0.035 ) {
		if ( valid ) {
			// reprojected history, clamped to the range of this frame's samples around it (with a
			// margin): real changes (lighting, motion the reprojection missed) can't leave ghosts,
			// so the samples can be averaged over many frames, which removes the noise
			let h = max( historyCatmullRom( puv, cloudsParams.viewSize ), vec4f( 0.0 ) );
			let lo = textureLoad( boxMin, vec2i( tp ), 0 ); let hi = textureLoad( boxMax, vec2i( tp ), 0 );
			let pad = ( hi - lo ) * 0.25 + 0.01;
			out = select( h, clamp( h, lo - pad, hi + pad ), T.rebuildK < 0.0 );
		} else {
			out = upsampled( p );
		}

		if ( fresh ) {
			let cu = textureLoad( traceTex, vec2i( tp ), 0 );
			let hl = textureLoad( highTrace, vec2i( tp ), 0 );
			let cur = clOver( cu, hl );
			// average the jittered samples over time (removes the ray march noise); a little
			// shorter where the clouds move fast on screen (the history is resampled every frame)
			let hist = out;
			let motion = length( ( puv - uv ) * cloudsParams.viewSize );
			let a0 = T.minAlpha;
			let a = clamp( motion * 0.1 + a0, a0, 0.35 );
			// rebuilding after a camera cut: each pixel takes its own first sample as is
			out = select( cur, mix( hist, cur, a ), valid && T.rebuildK < 0.0 );
		} else if ( T.rebuildK >= 0.0 && valid ) {
			// rebuilding: pixels without a sample of their own since the cut average the upsampled
			// samples of every slot traced so far (their refresh rank is the 4x4 Bayer index)
			let x = f32( p.x % 4u ); let y = f32( p.y % 4u );
			let rank = b2( x % 2.0, y % 2.0 ) * 4.0 + b2( floor( x / 2.0 ), floor( y / 2.0 ) );
			if ( rank > T.rebuildK ) {
				out = mix( out, upsampled( p ), 1.0 / ( T.rebuildK + 1.0 ) );
			}
		}
	}

	textureStore( dstHistory, p, vec4f( out.rgb, clamp( out.a, 0.0, 1.0 ) ) );
}` );

		const set = { block, trace, high, box, resolve: [ resolve( this.history[ 1 ], this.history[ 0 ] ), resolve( this.history[ 0 ], this.history[ 1 ] ) ] };
		this._traceSets[ i ] = set;
		return set;

	}

	_resize( fw, fh ) {

		this._w = fw;
		this._h = fh;
		this._scale = this.resolutionScale;
		const w = Math.max( 4, Math.round( fw * this._scale * HISTORY_SCALE ) ), h = Math.max( 4, Math.round( fh * this._scale * HISTORY_SCALE ) );
		this.displayH.value = Math.max( 4, fh * this._scale );
		const tw = Math.ceil( w / 4 ), th = Math.ceil( h / 4 );
		this.viewSize.value.set( w, h );
		this.traceSize.value.set( tw, th );
		for ( const t of [ this.traceTex, this.traceDepth, this.highTrace, this.boxMin, this.boxMax, this.motionTex ] ) t.resize( tw, th );
		this.history[ 0 ].resize( w, h );
		this.history[ 1 ].resize( w, h );
		// the new textures hold nothing until traced: the sky uses the panorama meanwhile
		this.viewValid.value = 0;
		this.resetHistory();

	}

	_drawingBufferSize() {

		if ( this.outputSize ) return this.outputSize;
		const r = this.renderer;
		if ( r && r.getDrawingBufferSize ) return r.getDrawingBufferSize( this._size || ( this._size = new Vector2() ) );
		if ( r && r.width && r.height ) return { x: r.width, y: r.height };
		if ( GPU.canvas ) return { x: GPU.canvas.width, y: GPU.canvas.height };
		return FrameUniforms.fields.outputResolution.value;

	}

	// ------------------------------------------------------------ per frame

	update( dt, camera ) {

		this._traceIndex = 0;

		// wind drift, kept bounded (every noise tiles within TILE)
		const wind = this.wind.value;
		const c = Math.cos( this._rot ), s = Math.sin( this._rot );
		const o = this.offset.value;
		o.addScaledVector( wind, dt );
		o.set( ( ( o.x % TILE ) + TILE ) % TILE, ( ( o.y % TILE ) + TILE ) % TILE );
		const ow = this._offsetW;
		ow.x += ( wind.x * c + wind.y * s ) * dt;
		ow.y += ( wind.y * c - wind.x * s ) * dt;
		ow.set( ( ( ow.x % TILE ) + TILE ) % TILE, ( ( ow.y % TILE ) + TILE ) % TILE );

		const oh = this._offsetH;
		oh.addScaledVector( wind, dt * 1.6 );
		oh.set( ( ( oh.x % TILE ) + TILE ) % TILE, ( ( oh.y % TILE ) + TILE ) % TILE );

		camera.updateMatrixWorld();
		const cp = camera.position;
		// the march assumes a camera below the cloud base
		this.camY.value = MathUtils.clamp( cp.y, 1, this.bottom.value - 50 );
		if ( wind.lengthSq() > 1e-6 ) this.windN.value.copy( wind ).normalize();
		this.horizonY.value = - Math.sqrt( 2 * this.camY.value / EARTH_R );
		// the field moves along +wind: sample it at (position - offset)
		this.nOrigin.value.set( cp.x - o.x, cp.z - o.y );
		this.wOrigin.value.set( cp.x * c + cp.z * s - ow.x, cp.z * c - cp.x * s - ow.y );

		// ---- coverage changes: rebuild the distance field when it no longer bounds the clouds (or
		// has become too loose to skip well); the view and panorama converge on their own
		const cov = this.coverage.value;
		if ( cov > this.sdfCoverage.value || cov < this.sdfCoverage.value - 0.1 ) {

			this.sdfCoverage.value = Math.min( cov + 0.04, 1 );
			this._buildSDF();

		}

		// ---- view camera frame
		const size = this._drawingBufferSize();
		if ( size.x !== this._w || size.y !== this._h || this.resolutionScale !== this._scale ) this._resize( size.x, size.y );
		const e = camera.matrixWorld.elements;
		const tanY = Math.tan( MathUtils.degToRad( camera.fov * 0.5 ) ) / ( camera.zoom || 1 );
		const C = this.cam, P = this.prev;
		P.right.value.copy( C.right.value );
		P.up.value.copy( C.up.value );
		P.fwd.value.copy( C.fwd.value );
		P.tan.value.copy( C.tan.value );
		C.right.value.set( e[ 0 ], e[ 1 ], e[ 2 ] ).normalize();
		C.up.value.set( e[ 4 ], e[ 5 ], e[ 6 ] ).normalize();
		C.fwd.value.set( - e[ 8 ], - e[ 9 ], - e[ 10 ] ).normalize();
		C.tan.value.set( tanY * camera.aspect, tanY );
		// camera cuts (teleports, big turns, time of day jumps, zoom): the history is useless, rebuild
		// it at full rate. Ordinary camera motion is handled by the reprojection
		const moved = this._hasPrev ? cp.distanceTo( this._prevCam ) : Infinity;
		const turned = C.fwd.value.angleTo( P.fwd.value );
		this._turned = turned;
		const sun = G.sunDir.value;
		if ( moved > 8 || turned > 0.5 || sun.angleTo( this._prevSun ) > 0.05 || Math.abs( C.tan.value.y - P.tan.value.y ) > 1e-3 * C.tan.value.y ) this.resetHistory();
		this._prevSun.copy( sun );
		// camera motion since last frame minus the wind drift of the clouds
		this.camDelta.value.set( cp.x - this._prevCam.x - wind.x * dt, cp.y - this._prevCam.y, cp.z - this._prevCam.z - wind.y * dt );
		this.camDeltaHi.value.set( cp.x - this._prevCam.x - wind.x * dt * 1.6, cp.y - this._prevCam.y, cp.z - this._prevCam.z - wind.y * dt * 1.6 );
		this._prevCam.copy( cp );
		this._hasPrev = true;

		this.shadowPhase.value = this.frame % 4;
		if ( this.frame % 4 === 0 ) this.shadowCenter.value.set( cp.x, cp.z );
		this.camXZ.value.set( cp.x, cp.z );
		this.hOffset.value.copy( oh );

		// ---- panorama: 1/32 of the texels per frame (8x4 blocks); all of them after a reset
		if ( this.panoWarm > 0 ) {

			this.panoFullKernel.dispatch( [ PANO_W / 8, PANO_H / 8, 1 ] );
			this.panoWarm = 0;

		}

		this._panoSlot( this.frame );
		const shadowAndPano = () => {

			this.shadowKernel.dispatch( [ SHADOW_RES / 8, SHADOW_RES / 32, 1 ] );
			this.panoKernel.dispatch( [ PANO_W / 64, PANO_H / 32, 1 ] );

		};

		if ( G.cameraUnderwater.value > 0.5 ) {

			// the sky is only seen through Snell's window (panorama): no view clouds
			shadowAndPano();
			this.resetHistory();

		} else if ( this._rebuild < 16 ) {

			// after a cut: several slots per frame, until every pixel has a sample of its own
			for ( let k = 0; k < REBUILD_SLOTS && this._rebuild < 16; k ++ ) {

				if ( k > 0 ) this._holdCamera();
				this.rebuildK.value = this._rebuild;
				this._trace( ORDER[ this._rebuild ++ ] );

			}

			shadowAndPano();

		} else {

			// samples every pixel holds since the cut
			const n = 1 + Math.floor( this._since ++ / 16 );
			this.minAlpha.value = Math.max( 0.12, 1 / ( n + 1 ) );
			this.rebuildK.value = - 1;
			this._trace( ORDER[ this.frame % 16 ] );
			shadowAndPano();
			// turning camera: a second slot per frame (every pixel refreshed in 8 frames instead of 16)
			// keeps the reprojected history from softening
			if ( this._turned > 0.003 ) {

				this._holdCamera();
				this._trace( ORDER[ ( this.frame + 8 ) % 16 ] );

			}

		}

		this.frame ++;

	}

	// trace one slot of every 4x4 block and resolve it into the history
	_trace( order ) {

		this.slot.value.set( order % 4, Math.floor( order / 4 ) );
		// R2 sequence over the traces (one offset per 16 frame cycle, so each pixel sees them all)
		const n = Math.floor( this._traces / 16 ) + 1;
		this.subPixel.value.set( ( ( 0.5 + n * 0.7548776662 ) % 1 ) - 0.5, ( ( 0.5 + n * 0.5698402910 ) % 1 ) - 0.5 ).multiplyScalar( 0.25 );
		// march jitter: a pixel is traced once per 16 frame cycle, so the offset advances per cycle
		// (golden ratio sequence on top of the pixel's IGN value): every trace of a pixel gets a new,
		// well spread offset and the history converges. (Stepping it per trace, mod 64, gave each
		// pixel only 4 offsets: a fixed residual of the step and light-march pattern, seen as grain.)
		this.frameNoise.value = ( n * 0.6180339887 ) % 1;
		this._traces ++;

		// this trace's own copy of the per-trace state
		const set = this._traceSet( this._traceIndex ++ );
		const B = set.block.fields, P = this.prev;
		B.slot.value.copy( this.slot.value );
		B.subPixel.value.copy( this.subPixel.value );
		B.frameNoise.value = this.frameNoise.value;
		B.rebuildK.value = this.rebuildK.value;
		B.minAlpha.value = this.minAlpha.value;
		B.historyValid.value = this.historyValid.value;
		B.prevRight.value.copy( P.right.value );
		B.prevUp.value.copy( P.up.value );
		B.prevFwd.value.copy( P.fwd.value );
		B.prevTan.value.copy( P.tan.value );
		B.camDelta.value.copy( this.camDelta.value );
		B.camDeltaHi.value.copy( this.camDeltaHi.value );

		const tg = [ Math.ceil( this.traceSize.value.x / 8 ), Math.ceil( this.traceSize.value.y / 8 ), 1 ];
		set.trace.dispatch( tg );
		set.high.dispatch( tg );
		set.box.dispatch( tg );
		set.resolve[ this._pp ].dispatch( [ Math.ceil( this.viewSize.value.x / 8 ), Math.ceil( this.viewSize.value.y / 8 ), 1 ] );
		this.viewTex = this.history[ this._pp ];
		this._pp = 1 - this._pp;
		this.historyValid.value = 1;
		const C = this.cam, V = this.viewCam;
		V.right.value.copy( C.right.value );
		V.up.value.copy( C.up.value );
		V.fwd.value.copy( C.fwd.value );
		V.tan.value.copy( C.tan.value );
		this.viewValid.value = 1;

	}

	// no camera motion between the traces of one frame
	_holdCamera() {

		const C = this.cam, P = this.prev;
		P.right.value.copy( C.right.value );
		P.up.value.copy( C.up.value );
		P.fwd.value.copy( C.fwd.value );
		P.tan.value.copy( C.tan.value );
		this.camDelta.value.set( 0, 0, 0 );
		this.camDeltaHi.value.set( 0, 0, 0 );

	}

	// Restart the view accumulation (camera cuts are also detected on their own), rebuilding it at
	// full rate over the next frames so no seam shows.
	resetHistory() {

		this._rebuild = 0;
		this._since = 0;
		this.historyValid.value = 0;

	}

	_panoSlot( k ) {

		const o = ORDER[ k % 16 ];
		this.panoSlot.value.set( ( o % 4 ) * 2 + ( Math.floor( k / 16 ) % 2 ), Math.floor( o / 4 ) );

	}

	_buildSDF() {

		const d = [ SDF_RES / 8, SDF_RES / 8, SDF_H ];
		for ( const k of [ this.sdfOccKernel, this.sdfXKernel, this.sdfYKernel, this.sdfZKernel ] ) k.dispatch( d );

	}

	// restart all accumulation (view, panorama)
	invalidate() {

		this.panoWarm = 1;
		this.resetHistory();

	}

}

// ------------------------------------------------------------ the ray march (one WGSL function per quality)

// Ray march the cumulus layer along rd (camera relative, camera on the planet axis).
// Returns { L, T, depth }: sky * T + L is the composite, L includes aerial perspective.
function marchWGSL( name, q ) {

	const bandStep = `min( exp2( b ) * ${ f( q.ds0 ) }, ${ f( q.dsMax ) } )`;
	let light = '';
	let prev = 0;
	for ( let k = 0; k < q.lightSteps.length; k ++ ) {

		const dist = q.lightSteps[ k ];
		const len = dist - prev;
		prev = dist;
		light += `\t\t\t\t{\n\t\t\t\t\tlet lp = cloudsSheared( pr + sunDir * ( lj * ${ f( dist - len * 0.5 ) } ) );\n`;
		if ( k < q.lightDetail ) {

			// detailed self shadowing matters near the visible surface only
			light += `\t\t\t\t\tlet lb = cloudsBase( lp, w );
					if ( T > 0.5 ) {
						// filtered at the size of the light segment
						od += cloudsErode( lp, lb, max( foot, ${ f( len * 0.35 ) } ) ).x * ${ f( len ) };
					} else {
						od += clMeanDensity( lb ) * ${ f( len ) };
					}\n`;

		} else {

			light += `\t\t\t\t\tlet lb = cloudsBase( lp, cloudsWeather( lp.xz ) );\n\t\t\t\t\tod += clMeanDensity( lb ) * ${ f( len ) };\n`;

		}

		light += '\t\t\t\t}\n';

	}

	return /* wgsl */`
fn cloudsBandStep${ name }( b: f32 ) -> f32 { return ${ bandStep }; }
fn cloudsSnapCoarse${ name }( t: f32, up: bool, jitter: f32, k0: f32 ) -> f32 {
	let b = cloudsBand( t ); let s0 = cloudsBandStart( b ); let ds = cloudsBandStep${ name }( b );
	let i = ( t - s0 ) / ds - jitter;
	let m = select( floor( i + 1e-3 ), ceil( i - 1e-3 ), up );
	let mc = select( m - cloudsPosMod( m - k0, ${ f( q.coarse ) } ), m + cloudsPosMod( k0 - m, ${ f( q.coarse ) } ), up );
	return s0 + ( mc + jitter ) * ds;
}
fn cloudsMarch${ name }( rd: vec3f, jitter: f32 ) -> CloudsMarch {
	let camY = cloudsParams.camY;
	let light = cloudsKeyLight( ( cloudsParams.bottom + cloudsParams.top ) * 0.0005 );
	let sunDir = light.dir;
	let pxAngle = ${ q.pxAngle };
	let t0 = max( cloudsShell( camY, rd, cloudsParams.bottom ), 0.0 );
	let t1 = min( cloudsShell( camY, rd, cloudsParams.top ), ${ f( q.maxDist ) } );
	var L = vec3f( 0.0 );
	var T = 1.0;
	var opac = 0.0;
	var tAcc = 0.0;
	var wAcc = 0.0;
	let k0 = floor( fract( jitter * 7.31 + 0.37 ) * ${ f( q.coarse ) } ); // coarse phase

	let cosT = dot( rd, sunDir );
	// multiple scattering octaves (Hillaire 2016): scattering a^i, extinction b^i, eccentricity c^i
	// (sky-pro-webgpu) normalized droplet phase: 80% forward / 20% back; each order halves the asymmetry
	let phase = vec3f( clPhaseHG( cosT, 0.8 ), clPhaseHG( cosT, 0.4 ), clPhaseHG( cosT, 0.2 ) ) * 0.8
		+ vec3f( clPhaseHG( cosT, -0.2 ), clPhaseHG( cosT, -0.1 ), clPhaseHG( cosT, -0.05 ) ) * 0.2;
	let ph3 = ${ f( 0.15 / ( 4 * PI ) ) }; // light diffused through the whole cloud (keeps thick bodies from going black)
	let sunE = light.E;
	let amb = frame.skyIrradiance * ${ f( q.ambient ) };
	// in-scatter probability (Schneider 2015 'powder', Nubis 2017): light scattered toward the viewer
	// builds up inside the cloud, so thin edges and the underside look darker; faded out looking
	// toward the sun, where the forward peak makes the thin edges glow (silver lining)
	let powderK = sat( cosT * -0.5 + 0.6 );
	// warm light bounced by the sunlit sea onto the undersides (at low sun the sunlight is warm)
	let bounce = frame.sunColor * ( max( sunDir.y, 0.0 ) * 0.01 + 0.003 );

	var t = cloudsSnapCoarse${ name }( t0, true, jitter, k0 );
	var bd = cloudsBand( t );
	// Nubis stepping: coarse steps with the cheap density until something is hit, then step
	// back and walk through it with fine, fully detailed samples
	var fineSteps = 0;

	if ( rd.y > cloudsParams.horizonY && t1 > t0 ) {
		for ( var it = 0; it < ${ q.maxSteps }; it++ ) {
			if ( t > t1 || T < 0.015 ) { break; }

			// entering the next distance band: onto its lattice
			if ( cloudsBand( t ) != bd ) {
				bd = cloudsBand( t );
				if ( fineSteps == 0 ) {
					t = cloudsSnapCoarse${ name }( t, true, jitter, k0 );
				} else {
					let s0 = cloudsBandStart( bd ); let d0 = cloudsBandStep${ name }( bd );
					t = s0 + ( ceil( ( t - s0 ) / d0 - jitter - 1e-3 ) + jitter ) * d0;
				}
			}

			let pr = vec3f( rd.x * t, camY + rd.y * t, rd.z * t );
			let p = cloudsSheared( pr );
			let ds = cloudsBandStep${ name }( bd );

			if ( fineSteps == 0 ) {
				let sk = cloudsSkip( p );
				// the shear can move the sample up to 12% more than the ray
				let jump = sk * 0.89;
				if ( jump > ds * ${ f( q.coarse ) } ) {
					// far from any cloud: jump, landing on the coarse lattice (at least one stride on)
					t = max( cloudsSnapCoarse${ name }( t + jump, false, jitter, k0 ), t + ds * ${ f( q.coarse ) } );
					bd = cloudsBand( t );
				} else {
					let b = cloudsBase( p, cloudsWeather( p.xz ) );
					// switch to fine steps a little before the surface so thin wisps aren't skipped
					if ( b.x > -0.08 ) {
						t -= ds * ${ f( q.coarse - 1 ) };
						fineSteps = 5;
					} else {
						t += ds * ${ f( q.coarse ) };
					}
				}
			} else {
				let w = cloudsWeather( p.xz );
				let b = cloudsBase( p, w );
				fineSteps -= 1;

				if ( b.x > 0.002 ) {
					fineSteps = 3;
					// detail level from the pixel footprint (m): the close range octave (lumps of ~13 - 51 m)
					// fades out beyond ~3 km, the erosion (~47 - 190 m) beyond ~24 km, so nothing smaller
					// than about two pixels is ever sampled (that would only alias into grain)
					let foot = t * pxAngle;
					var er = vec2f( clMeanDensity( b ), 1.0 - clMeanCrease( b ) );
					// detail erosion (every octave under 2 px: the mean erosion above)
${ q.detail ? `\t\t\t\t\tif ( foot < ${ f( D_S1 * 0.24 ) } ) { er = cloudsErode( p, b, foot ); }` : '' }
					let dens = er.x;

					if ( dens > 0.002 ) {
						// light march toward the sun: near samples share the weather and keep the
						// detail, far ones only see the base shape
						var od = 0.0;
						// jittered along the light ray: its sampling pattern turns into noise the
						// temporal filter removes, instead of streaks across the cloud
						let lj = fract( jitter + 0.5 ) * 0.3 + 0.85;
${ light }
						let sig = dens * cloudsParams.densityScale;
						// light optical depth (the local segment included); multiple scattering lowers the
						// effective extinction of the light
						let tau = ( od + dens * 6.0 ) * cloudsParams.densityScale;
						// single scattering (dual-lobe HG) through the true optical depth, one multiple
						// scattering octave (Wrenninge 2013: extinction and eccentricity lowered), and the
						// diffusion regime of a thick, non-absorbing cloud: diffuse light is transmitted
						// ~ 1 / (1 + 0.75 (1 - g) tau), so a sunlit surface reflects like a bright diffuser and
						// the shaded side stays grey, not black (the octave sum alone was ~4x too dark)
						// multiply scattered light builds up with height in the cloud (Nubis 'vertical
						// probability'): the lower parts are darker
						let msV = mix( 0.35, 1.0, smoothstep( 0.0, 0.45, b.y ) );
						let sun = phase.x * exp( -tau ) + ( phase.y * 0.6 * exp( tau * -0.3 )
							+ phase.z * ( CL_MS / pow2( 1.0 + 0.1 * tau ) ) + ph3 * exp( tau * -0.03 ) ) * msV;
						// skylight occlusion: two broad upward probes (125 m, 600 m) of the filtered density
						let pu1 = cloudsSheared( pr + vec3f( 0.0, 125.0, 0.0 ) ); let pu2 = cloudsSheared( pr + vec3f( 0.0, 600.0, 0.0 ) );
						let skyTau = ( clMeanDensity( cloudsBase( pu1, w ) ) * 250.0 + clMeanDensity( cloudsBase( pu2, cloudsWeather( pu2.xz ) ) ) * 700.0
							+ dens * 25.0 ) * cloudsParams.densityScale;
						let skyVis = 0.3 + 0.7 / ( skyTau * 0.35 + 1.0 );
						// darker bases (their direct light is scattered away by the cloud above)
						let baseShadow = mix( 0.55, 1.0, smoothstep( -0.1, 0.45, b.y ) );
						let depthP = pow( dens, mix( 0.5, 1.6, b.y ) ) * 0.95 + 0.05;
						let vertP = pow( smoothstep( 0.02, 0.2, b.y ), 0.8 ) * 0.85 + 0.15;
						let powder = mix( 1.0, depthP * vertP, powderK );
						// ambient: the sky lights the tops; the bases only see the dark sea and the
						// horizon (darker, bluer), and crevices of the detail noise are occluded
						let up = sat( b.y * 1.4 );
						let ambH = mix( vec3f( 0.45, 0.5, 0.58 ), vec3f( 1.0 ), sqrt( up ) ) * skyVis * ( er.y * 0.75 + 0.42 );
						// after sunset the tops stay lit longest
						let alt = pr.y + dot( pr.xz, pr.xz ) / ${ f( 2 * EARTH_R ) };
						let S = sunE * ( sun * powder * baseShadow * ( er.y * 0.5 + 0.5 ) * cloudsEarthShadow( light, alt, pr.xz ) ) + amb * ambH
							+ bounce * ( 1.0 - up );
						let Tstep = exp( - sig * ds );
						let tap = exp( t * ${ f( - 1 / AP_DIST ) } );
						let dT = T * ( 1.0 - Tstep );
						L += S * dT * tap;
						opac += dT * tap;
						tAcc += t * dT;
						wAcc += dT;
						T *= Tstep;
					}
				}

				t += ds;
				if ( fineSteps == 0 ) {
					t = cloudsSnapCoarse${ name }( t, true, jitter, k0 );
				}
			}
		}
	}

	var m: CloudsMarch;
	m.depth = select( t0 + 4000.0, tAcc / max( wAcc, 1e-4 ), wAcc > 1e-4 );
	// aerial perspective: the haze in front of distant clouds shows sky light where the cloud
	// hides the sky (sky luminance times the hidden fraction not reached by the cloud's light)
	// the march stops at 98.5% opacity: the rest counts as opaque (the sun disc must not shine through)
	let Tc = sat( ( T - 0.015 ) / 0.985 );
	let haze = 1.0 - Tc - opac;
	m.L = L + atmosphereSkyLuminance( rd ) * max( haze, 0.0 );
	m.T = Tc;
	return m;
}
`;

}
