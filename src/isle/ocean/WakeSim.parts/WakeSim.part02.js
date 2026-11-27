fn wakeApply( Z: vec4f, Zm: vec4f, p: vec2f, m: vec2f ) -> vec4f {
	return vec4f( Z.x * p.x + Zm.x * m.x, Z.y * p.x - Zm.y * m.x, Z.z * p.y + Zm.z * m.y, Z.w * p.y - Zm.w * m.y );
}

@compute @workgroup_size( WG_X, 1, 1 )
fn main( @builtin( local_invocation_id ) lid: vec3u, @builtin( workgroup_id ) wid: vec3u ) {
	let t = lid.x;
	let wg = wid.x;
	if ( wg <= WAKE_HALF ) {
		let cA = wg;
		let cB = ( WAKE_N - wg ) & WAKE_MASK;
		for ( var e = 0u; e < 2u; e++ ) {
			let r = t + e * WAKE_HALF;
			let rb = wakeBrev( r );
			shCol[ rb ] = wakeSpec[ r * WAKE_N + cA ];
			shCol[ rb + WAKE_N ] = wakeSpec[ r * WAKE_N + cB ];
		}
		workgroupBarrier();
${ stages( 'shCol', [ 0, N ], - 1 ) }
		let fx = f32( select( i32( cA ) - i32( WAKE_N ), i32( cA ), cA < WAKE_HALF ) ) * ${ f( dk ) };
		var outs: array<vec4f, 4>;
		for ( var e = 0u; e < 2u; e++ ) {
			let r = t + e * WAKE_HALF;
			let rm = ( WAKE_N - r ) & WAKE_MASK;
			let fz = f32( select( i32( r ) - i32( WAKE_N ), i32( r ), r < WAKE_HALF ) ) * ${ f( dk ) };
			let k = length( vec2f( fx, fz ) );
			let L0 = ${ Lk[ 0 ] }; let L1 = ${ Lk[ 1 ] }; let L2 = ${ Lk[ 2 ] }; let L3 = ${ Lk[ 3 ] };
			let p = vec2f( L0 + L1, L2 + L3 ) * 0.5;
			let m = vec2f( L0 - L1, L2 - L3 ) * 0.5;
			outs[ e * 2u ] = wakeApply( shCol[ r ], shCol[ rm + WAKE_N ], p, m );
			outs[ e * 2u + 1u ] = wakeApply( shCol[ r + WAKE_N ], shCol[ rm ], p, m );
		}
		workgroupBarrier();
		for ( var e = 0u; e < 2u; e++ ) {
			let rb = wakeBrev( t + e * WAKE_HALF );
			shCol[ rb ] = outs[ e * 2u ];
			shCol[ rb + WAKE_N ] = outs[ e * 2u + 1u ];
		}
		workgroupBarrier();
${ stages( 'shCol', [ 0, N ], 1 ) }
		for ( var e = 0u; e < 2u; e++ ) {
			let r = t + e * WAKE_HALF;
			wakeSpec[ r * WAKE_N + cA ] = shCol[ r ];
			if ( cB != cA ) {
				wakeSpec[ r * WAKE_N + cB ] = shCol[ r + WAKE_N ];
			}
		}
	} else if ( wg <= WAKE_HALF + ${ Math.ceil( TW * TH / HALF ) }u ) {
		// near-field template (spare workgroups): running mean of the wake height at
		// boat-frame points
		let k = ( wg - ( WAKE_HALF + 1u ) ) * WAKE_HALF + t;
		if ( k < WAKE_TW * WAKE_TH ) {
			let tx = k % WAKE_TW; let tz = k / WAKE_TW;
			let bx = ( f32( tx ) + 0.5 ) * ${ f( ( TX1 - TX0 ) / TW ) } + ${ f( TX0 ) };
			let bz = ( f32( tz ) + 0.5 ) * ${ f( ( TZ1 - TZ0 ) / TH ) } + ${ f( TZ0 ) };
			let cs = wk.boatRot.x; let sn = wk.boatRot.y;
			let pw = wk.boatPos + vec2f( bx * cs + bz * sn, bz * cs - bx * sn );
			let eta = textureSampleLevel( wakeDisplayTex, smpLinearRepeat, pw / WAKE_SIZE, 0.0 ).x;
			let prev = wakeNearBuf[ k ];
			let mean = prev + ( eta - prev ) * wk.nearRate;
			wakeNearBuf[ k ] = mean;
			let border = tx == 0u || tx == WAKE_TW - 1u || tz == 0u || tz == WAKE_TH - 1u;
			let D = textureSampleLevel( wakeHullTex, smpLinearClamp, vec2f( abs( bx ) / ${ f( HB.X1 ) }, ( bz - ${ f( HB.Z0 ) } ) / ${ f( HB.Z1 - HB.Z0 ) } ), 0.0 ).x;
			let m = select( smoothstep( 0.0, 0.03, D ), 0.0, border );
			textureStore( wakeNearOut, vec2u( tx, tz ), vec4f( mean, m, 0.0, 0.0 ) );
		}
	}
}
`,
		} );

		// ---- pass 3: inverse FFT along rows, time step, sponge
		this.invKernel = new ComputeKernel( {
			label: 'Wake Inverse',
			modules: [ simModule ],
			workgroupSize: [ HALF, 1, 1 ],
			code: /* wgsl */`
var<workgroup> shRow: array<vec4f, ${ N }>;

@compute @workgroup_size( WG_X, 1, 1 )
fn main( @builtin( local_invocation_id ) lid: vec3u, @builtin( workgroup_id ) wid: vec3u ) {
	let t = lid.x;
	let row = wid.x;
	let dt = wk.dt;
	for ( var e = 0u; e < 2u; e++ ) {
		let col = t + e * WAKE_HALF;
		shRow[ wakeBrev( col ) ] = wakeSpec[ row * WAKE_N + col ];
	}
	workgroupBarrier();
${ stages( 'shRow', [ 0 ], 1 ) }
	let rl = f32( ( i32( row ) - i32( wk.origin.y ) ) & i32( WAKE_MASK ) ) + 0.5;
	let ez = min( rl, f32( WAKE_N ) - rl );
	for ( var e = 0u; e < 2u; e++ ) {
		let col = t + e * WAKE_HALF;
		let idx = row * WAKE_N + col;
		let Y = shRow[ col ];
		let sc = wakeScratch[ idx ];
		let p = wakeCellPos( col, row );
		let d = frame.seaLevel - terrainHeightAt( p );
		let Lu = dot( wakeDepthWeights( d ), Y );
		let w1 = sc.y - Lu * ( dt * ${ f( GRAVITY ) } );
		let h1 = sc.x + w1 * dt;
		let cl = f32( ( i32( col ) - i32( wk.origin.x ) ) & i32( WAKE_MASK ) ) + 0.5;
		let edge = min( min( cl, f32( WAKE_N ) - cl ), ez );
		let sig = smoothstep( ${ f( SPONGE ) }, 0.0, edge );
		let k = exp( dt * ( sig * sig * - 6.0 ) );
		wakeState[ idx ] = vec4f( h1 * k, w1 * k, sc.z, sc.w );
		wakeAerA[ idx ] = wakeAerB[ idx ];
	}
}
`,
		} );

	}

	// ---------------------------------------------------------------- readers (WGSL)

	_buildReaders() {

		// one sampler for the whole wake: the display texture (height, slopes, foam); the
		// near-field template and the aeration are read with textureLoad (no sampler)
		this.module = new ShaderModule( {
			name: 'wake',
			deps: [ this.commonModule ],
			uniforms: this.readerParams,
			uniformName: 'wakeParams',
			bindings: {
				wakeDisplay: { texture: this.display },
				wakeNear: { texture: this.nearTex },
				wakeAerTex: { texture: this.aerTex },
			},
			code: /* wgsl */`
fn wakeEdgeDist( xz: vec2f ) -> f32 {
	let rel = abs( xz - wakeParams.center );
	return WAKE_SIZE / 2.0 - max( rel.x, rel.y );
}
fn wakeFade( xz: vec2f ) -> f32 { return smoothstep( 4.0, 16.0, wakeEdgeDist( xz ) ) * wakeParams.amount; }
// foam and aeration: a long fade toward the window edge, no visible end of the track
fn wakeFadeLong( xz: vec2f ) -> f32 { return smoothstep( 4.0, 45.0, wakeEdgeDist( xz ) ) * wakeParams.amount; }

// template texel coordinates of world xz (boat frame)
fn wakeNearCoord( xz: vec2f ) -> vec2f {
	let rel = xz - wakeParams.boatPos;
	let cs = wakeParams.boatRot.x; let sn = wakeParams.boatRot.y;
	let bx = rel.x * cs - rel.y * sn; let bz = rel.x * sn + rel.y * cs;
	return vec2f( ( bx - ${ f( TX0 ) } ) * ${ f( TW / ( TX1 - TX0 ) ) }, ( bz - ${ f( TZ0 ) } ) * ${ f( TH / ( TZ1 - TZ0 ) ) } ) - 0.5;
}
fn wakeInTemplate( tc: vec2f ) -> bool { return tc.x > 0.0 && tc.y > 0.0 && tc.x < ${ f( TW - 1 ) } && tc.y < ${ f( TH - 1 ) }; }

// (outside the simulated window, or asleep, both fades are 0: nothing to read)
fn wakeOff( xz: vec2f ) -> bool { return wakeParams.amount <= 0.0 || wakeEdgeDist( xz ) <= 4.0; }

fn wakeSample( xz: vec2f ) -> vec4f {
	if ( wakeOff( xz ) ) { return vec4f( 0.0 ); }
	var s = textureSampleLevel( wakeDisplay, smpLinearRepeat, xz / WAKE_SIZE, 0.0 ) * vec4f( vec3f( wakeFade( xz ) ), wakeFadeLong( xz ) );
	// the forced depression under the hull is covered by it: keep its edge out of the normals
	let tc = wakeNearCoord( xz );
	if ( wakeInTemplate( tc ) ) {
		let m = textureLoad( wakeNear, vec2i( tc + 0.5 ), 0 ).y;
		s = vec4f( s.x, s.yz * ( 1.0 - m ), s.w );
	}
	return s;
}

// aeration (0..aerOut): the aeration texture is read with textureLoad (bilinear by hand), then
// mottled: a noise fixed in the water sets how milky each patchN is and where the band's edge
// falls (soft, irregular), so it breaks into clouds and streaks instead of a uniform ribbon
fn wakeAeration( xz: vec2f ) -> f32 {
	var out = 0.0;
	if ( wakeOff( xz ) ) { return out; }
	let tc = xz / WAKE_CELL - 0.5;
	let i = vec2i( floor( tc ) );
	let fr = fract( tc );
	let M = vec2i( i32( WAKE_MASK ) );
	let a = mix( mix( textureLoad( wakeAerTex, i & M, 0 ).x, textureLoad( wakeAerTex, ( i + vec2i( 1, 0 ) ) & M, 0 ).x, fr.x ),
		mix( textureLoad( wakeAerTex, ( i + vec2i( 0, 1 ) ) & M, 0 ).x, textureLoad( wakeAerTex, ( i + vec2i( 1, 1 ) ) & M, 0 ).x, fr.x ), fr.y );
	if ( a > 0.01 ) {
		let m = wakeNoise( xz * 0.3 + vec2f( frame.time * 0.02, 0.0 ) ) * 0.55 + wakeNoise( xz * 0.85 + 17.3 ) * 0.45;
		let aN = ( 1.0 - exp( a * - 0.5 ) ) * ( m * 0.8 + 0.6 );
		out = smoothstep( m * 0.2 + 0.03, m * 0.2 + 0.55, aN ) * wakeParams.aerOut * wakeFadeLong( xz );
	}
	return out;
}

fn wakeHeight( xz: vec2f ) -> f32 {
	if ( wakeOff( xz ) ) { return 0.0; }
	var h = textureSampleLevel( wakeDisplay, smpLinearRepeat, xz / WAKE_SIZE, 0.0 ).x;
	let tc = wakeNearCoord( xz );
	if ( wakeInTemplate( tc ) ) {
		// under the hull only waves moving relative to it remain (an old wake being crossed);
		// small residuals are sampling jitter of the steep near field and are dropped
		// (bilinear by hand: the template has no sampler)
		let i = vec2i( floor( tc ) );
		let fr = fract( tc );
		let a = textureLoad( wakeNear, i, 0 ); let b = textureLoad( wakeNear, i + vec2i( 1, 0 ), 0 );
		let c = textureLoad( wakeNear, i + vec2i( 0, 1 ), 0 ); let d = textureLoad( wakeNear, i + vec2i( 1, 1 ), 0 );
		let t = mix( mix( a, b, fr.x ), mix( c, d, fr.x ), fr.y );
		let r = h - t.x;
		h = mix( h, r * smoothstep( wakeParams.dead.x, wakeParams.dead.y, abs( r ) ), t.y );
	}
	return h * wakeFade( xz ) * wakeParams.amplitude;
}

// Displacement (vec3) of the wake surface at world xz (Lagrangian point of the ocean grid).
fn wakeDisplacement( xz: vec2f ) -> vec3f { return vec3f( 0.0, wakeHeight( xz ), 0.0 ); }

// slopes: (dh/dx, dh/dz), foam, aeration (0..1, bubbles in the water column: the prop race and
// breaking; lingers ~25 s, widening)
struct WakeFrag { slopes: vec2f, foam: f32, aeration: f32 };
fn wakeFragment( xz: vec2f ) -> WakeFrag {
	let s = wakeSample( xz );
	var o: WakeFrag;
	o.slopes = s.yz * wakeParams.amplitude;
	o.foam = s.w;
	o.aeration = wakeAeration( xz );
	return o;
}
`,
		} );

	}

	// ---------------------------------------------------------------- per frame

	_dispatch() {

		GPU.computePass( 'Wake', ( pass ) => {

			this.rowKernel.dispatch( N, { pass } );
			this.colKernel.dispatch( N, { pass } );
			this.invKernel.dispatch( N, { pass } );

		} );

	}

	update( dt ) {

		const b = this.boat;
		const speed = Math.hypot( b.velocity.x, b.velocity.z );
		const moving = speed > 0.5 || ( b.driven && Math.abs( b.throttle ) > 0.04 );
		this.idleTime = moving ? 0 : this.idleTime + dt;

		if ( this.idleTime > this.settleTime ) {

			// asleep: nothing is dispatched; the (faded out) output is ignored by the shaders
			this.sleeping = true;
			this.uAmount.value = 0;
			// one step on the first frame compiles the pipelines behind the loading screen, not
			// when the player first opens the throttle
			if ( ! this.primed ) this._prime();
			return;

		}

		if ( this.sleeping ) {

			this.sleeping = false;
			this.hasWindow = false;
			this.uReset.value = 1;

		}

		this.uAmount.value = Math.min( 1, ( this.settleTime - this.idleTime ) / 4 );
		const h = Math.min( Math.max( dt, 1 / 240 ), 1 / 30 );
		this.uDt.value = h;

		// ---- window: keep the boat inside a box around the centre (moves by whole cells)
		const bx = b.position.x / CELL, bz = b.position.z / CELL;
		const box = 170; // the boat runs up to 68 m off centre: ~170 m of track behind it, ~25 m ahead
		const c = this.center;
		if ( ! this.hasWindow || Math.abs( bx - c.x ) > N || Math.abs( bz - c.y ) > N ) {

			c.set( Math.round( bx ), Math.round( bz ) );
			this.hasWindow = true;
			this.uReset.value = 1;

		}

		if ( bx - c.x > box ) c.x = Math.ceil( bx - box );
		if ( c.x - bx > box ) c.x = Math.floor( bx + box );
		if ( bz - c.y > box ) c.y = Math.ceil( bz - box );
		if ( c.y - bz > box ) c.y = Math.floor( bz + box );
		this.uPrev.value.copy( this.uOrigin.value );
		this.uOrigin.value.set( c.x - HALF, c.y - HALF );
		if ( this.uReset.value > 0.5 ) this.uPrev.value.copy( this.uOrigin.value );
		this.uCenter.value.set( c.x * CELL, c.y * CELL );

		// ---- boat
		const fw = b.forward( _fwd );
		const yaw = Math.atan2( fw.x, fw.z );
		this.uBoatPos.value.set( b.position.x, b.position.z );
		this.uBoatRot.value.set( Math.cos( yaw ), Math.sin( yaw ) );
		this._scheduleTrim( speed );
		this.uSpeed.value = speed;
		this.uDyn.value = this.dynamicPressure * speed * speed / ( 2 * GRAVITY );
		const plane = MathUtils.smoothstep( speed, 2, 9 );
		this.uHollow.value = 0.35 + 0.015 * speed * speed;
		this.uHollowK.value = 0.3 * plane;
		this.uSource.value = this.sourceGain * ( 1 + 0.2 * plane );
		const prop = b.driven ? Math.abs( b.throttle ) * b.rpm : 0;
		this.uWash.value = prop * 1.0 + MathUtils.smoothstep( speed, 1.5, 7 ) * 0.5;
		this.uWashW.value = 0.7 + 0.6 * MathUtils.smoothstep( speed, 2, 9 );
		this.uBow.value = MathUtils.smoothstep( speed, 3.5, 9 );

		this.uNearRate.value = this.uReset.value > 0.5 ? 1 : 1 - Math.exp( - h / 0.25 );
		// (the kernel block uploads when the first kernel binds and nothing else reads it this frame:
		// clearing the reset flag below only affects the next step)
		this._dispatch();
		this.primed = true;
		this.uReset.value = 0;
		this.stepCount ++;

	}

	_prime() {

		this.primed = true;
		this.uReset.value = 1;
		this.uPrev.value.copy( this.uOrigin.value );
		this._dispatch();

	}

	// Immersion change of the hull relative to its design waterline, c + a x + b z (m), scheduled
	// from speed rather than fitted to the boat's pose: the boat feels its own pressure field
	// through the water queries 1-3 frames late, and any dependence of the source on the boat's
	// heave / pitch / roll closes a delayed feedback loop (porpoising). Coming onto the plane the
	// hull rises and the bow lifts out, so the pressure footprint moves aft.
	_scheduleTrim( speed ) {

		const plane = MathUtils.smoothstep( speed, 3, 10 );
		this.uTrim.value.set( - 0.08 * plane, 0, - 0.035 * plane );

	}

}

const _fwd = new Vector3();
