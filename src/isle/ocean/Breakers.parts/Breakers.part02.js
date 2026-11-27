	let c0 = breakersCrest[ e ];
	let c1 = breakersCrest[ e + 1u ];
	let c2 = breakersCrest[ e + 2u ];
	let mOther = breakersCrest[ eo + 2u ].w;
	let bOther = breakersCrest[ eo ].w;
	// (the crests are followed until the bore reaches the shore; the sheet is gone after the plunge)
	// (port: both ends of a segment must pass the b test, else a vertex pair collapses to one side only
	// and the quad between them draws as a long sliver down to y = -1e5 where b jumps between stations)
	let valid = c2.w > 0.5 && abs( mOther - c2.w ) < 0.5 && c0.w < 1.25 && bOther < 1.25;

	let root = c0.xyz;
	let b = c0.w;
	let back = c1.xyz;
	let H = c1.w;
	let d3 = vec3f( c2.x, 0.0, c2.y );
	let trough = c2.z;
	let q = clamp( b / 0.9, 0.0, 1.35 );
	let Xi = max( H * 0.8, 0.05 );
	let Yi = max( root.y - trough, 0.05 );
	// profile parameter: k = 0, 1 on the back of the crest (-1, -0.45), then 0..1 along the curtain
	let pv = select( select( ( k - 2.0 ) / ( BRK_NV - 3.0 ), -0.45, k < 1.5 ), -1.0, k < 0.5 );
	let xl = Xi * q * max( pv, 0.0 );
	let fl = xl / Xi;
	let yl = - Yi * ( fl * fl ); // ballistic: the jet leaves the crest horizontally
	let onLip = root + d3 * xl + vec3f( 0.0, yl, 0.0 );
	let onCap = mix( root, back, max( - pv, 0.0 ) ) + vec3f( 0.0, 0.012, 0.0 );
	let P = select( onLip, onCap, pv < 0.0 );
	// outward normal of the curtain (upper surface of the lip)
	let slope = Yi * 2.0 * xl / ( Xi * Xi );
	o.vLipN = normalize( vec3f( 0.0, 1.0, 0.0 ) + d3 * slope );
	o.vLip = vec4f( pv, b, f32( st ) * ${ f( spacing ) }, Xi * q + Yi * q * q ); // w: curtain length (m)
	// the cap fades in over the crest; the whole lip fades out once it has become whitewater
	let capA = smoothstep( -1.0, -0.1, pv );
	// once the jet has re-entered the water the curtain is gone (the splash and the roller take over)
	o.vLipFade = capA * smoothstep( 0.02, 0.12, q ) * ( 1.0 - smoothstep( 1.0, 1.2, b ) );
	v.useWorld = true;
	v.worldPos = select( vec3f( 0.0, -1e5, 0.0 ), P, valid );
	v.worldNormal = o.vLipN;
`,
			output: /* wgsl */`
	let v = in.vs.vLip.x;
	let b = in.vs.vLip.y;
	let a = in.vs.vLip.z;
	let len = in.vs.vLip.w;
	let pos = in.P;
	let V = normalize( frame.cameraPos - pos );
	let Nw = normalize( in.vs.vLipN );
	let N0 = select( - Nw, Nw, in.front );
	let t = frame.time;
	// The water of the jet is stretched along the flow: streaks and ripples running down the
	// curtain (the lace pattern stretched ~8x along the jet and moving with it) in its surface
	// (normal, from the screen-space gradient of a small relief) and in its thickness
	let flowS = v * len - t * 1.1;
	// along-crest coordinate warped by low-frequency noise (three incommensurate scales, slope kept
	// below 1 so it never folds): the streak spacing drifts along the crest, no fixed period, and the
	// tiles of every pattern below never line up into a comb
	let aw = a + sin( a * 0.23 + 1.7 ) * 1.6 + sin( a * 0.61 + 4.2 ) * 0.4 + sin( a * 1.37 + 0.4 ) * 0.12;
	let sv = textureSample( brkLace, smpAnisoRepeat, vec2f( aw / 0.83, flowS / 3.0 ) );
	// and broad bands (sections of the lip thicker or thinner than others), visible from afar
	let sbv = textureSample( brkLace, smpAnisoRepeat, vec2f( aw / 2.9, flowS / 9.0 ) + vec2f( 0.37, 0.61 ) );
	let sb = sbv.z;
	let hS = sv.x * 0.02 + sv.z * 0.012;
	let dpx = dpdx( pos );
	let dpy = dpdy( pos );
	let r1 = cross( dpy, N0 );
	let r2 = cross( N0, dpx );
	let det = dot( dpx, r1 );
	let grad = ( r1 * dpdx( hS ) + r2 * dpdy( hS ) ) * sign( det );
	let N = normalize( N0 * abs( det ) - grad + N0 * 1e-9 );
	let NdV = max( dot( N, V ), 1e-3 );
	let F = breakersFresnel( NdV, 1.333 );
	let L = frame.sunDir;
	let sun = frame.sunColor * ${ this.clouds ? 'cloudsShadow( pos.xz )' : '1.0' };

	// reflection: sky + sun glint
	let Rr = reflect( - V, N );
	let R = normalize( vec3f( Rr.x, max( Rr.y, 0.004 ), Rr.z ) );
	let refl = ${ this.sky ? 'skyReflectionRadiance( R )' : 'frame.horizonColor' };
	let Hh = normalize( L + V );
	let spec = sun * ( pow( max( dot( N, Hh ), 0.0 ), 180.0 ) * 12.0 ) * F;

	// light through the thin sheet: turquoise when backlit
	let tint = vec3f( 0.16, 0.62, 0.56 );
	let back = pow( sat( dot( - V, L ) * 0.5 + 0.5 ), 4.0 );
	// thick and deep green at the root, thin, bright and clear toward the tip, uneven along the streaks
	let thin = mix( 1.5, 0.7, v ) * ( sv.z * 0.3 + 0.8 ) * ( sb * 0.8 + 0.6 );
	let glow = ( sun * tint * ( back * 0.9 + 0.08 ) + frame.skyIrradiance * tint * 1.4 ) * thin;
	let aW = F + min( ( 1.0 - F ) * mix( 0.42, 0.16, v ) * ( sv.x * 0.5 + 0.75 ) * ( sb * 0.7 + 0.65 ), 0.85 );
	let cW = refl * F + spec + glow * ( 1.0 - F ) * 0.42;

	// The jet stays clear, glassy water while it is in the air: only its leading edge tears into
	// aerated fingers (filaments of the lace pattern stretched along the flow, merging into a
	// ragged white rim). Sections of the lip differ a little.
	let flowM = v * len - t * 1.1; // metres down the curtain, moving with the jet
	let fuv = vec2f( aw / 1.9 + 0.53, flowM / 1.8 );
	let fl = textureSample( brkLace, smpAnisoRepeat, fuv );
	let sect = fl.z; // slowly varying along the crest
	let vary = sect - 0.5 + sin( aw * 0.29 + b * 2.1 ) * 0.15;
	let reach = v + vary * 0.3;
	// slightly irregular leading edge (sections of the lip reach a little further than others)
	let tipN = sin( aw * 1.3 + t * 0.3 ) * 0.6 + sin( aw * 4.7 + 1.3 ) * 0.4;
	let edge = v + tipN * 0.03 + vary * 0.04;
	let thrown = smoothstep( 0.35, 0.8, b );
	// a thin, translucent aerated rim along the leading edge (it tears into the drops and
	// ligaments the spray system throws off it)
	let rim = smoothstep( 0.9, 0.96, edge ) * ( fl.z * 0.2 + 0.2 ) * thrown;
	// once the lip has landed the curtain is a falling mass of whitewater that dissolves (blotchy)
	// into the splash-up and the roller within a fraction of a second
	// (in streaks: white fingers run down the curtain ahead of the rest, so along a peeling crest the
	// broken section feathers into the clear one instead of ending on a vertical line)
	// (each finger its own length and brightness: the fine strands' per-cell random, gated and grouped
	// by the broad pattern so fingers cluster, merge and leave gaps instead of a regular row)
	let fing = ( sv.w * 0.55 + sv.z * 0.2 ) * ( smoothstep( 0.25, 0.75, sbv.w * 0.6 + sb * 0.4 ) * 0.8 + 0.2 ) * 0.34;
	let wh = smoothstep( ( 1.0 - v ) * 0.18 + 0.9 - fing, ( 1.0 - v ) * 0.18 + 1.0 - fing, b ); // from the tip up
	let lc = textureSample( brkLace, smpAnisoRepeat, vec2f( aw * 0.83 + 1.9, v * len - t * 1.3 ) / ( BRK_LACE_TILE * 0.8 ) );
	let blot = lc.z * 0.7 + lc.y * 0.3;
	let gone = smoothstep( 1.0, 1.25, b );
	let clumpW = smoothstep( gone - 0.12, gone + 0.12, blot );
	let clumps = sat( ( blot - gone ) * 2.5 ); // thicker inside the blotches
	// thin aerated filaments stretched down the curtain (foam of the previous wave drawn up the
	// face and thrown out with the lip), more of them toward the tip
	let fil = ( 1.0 - smoothstep( 0.02, 0.12, sv.x ) ) * smoothstep( 0.15, 0.8, v ) * ( sv.w * 0.5 + 0.25 ) * ( sb * 0.9 + 0.3 ) * thrown;
	let aer = mix( max( rim, fil ), 0.95, wh );
	// aerated water is a dense scatterer: bright from every side, glowing when backlit
	let foamLit = ( sun * ( max( dot( N, L ), 0.0 ) * 0.5 + 0.5 + back * 1.2 ) / PI + frame.skyIrradiance ) * 0.9;

	let tip = 1.0 - smoothstep( 0.93, 1.0, edge );
	let alpha = in.vs.vLipFade * tip * mat.sheet * mix( 1.0, clumpW, wh );
	let aF = aer * 0.92;
	let col = foamLit * mix( 1.0, clumps * 0.4 + 0.75, wh ) * aF + cW * ( 1.0 - aF );
	let aOut = ( aF + aW * ( 1.0 - aF ) ) * alpha;
	(*r).color = vec4f( col * alpha, aOut );
`,
		} );
		// the lip opacity multiplier is the material's uniform
		this.params.sheet = mat.uniforms.sheet;
		this.material = mat;

		const mesh = this.mesh = new Mesh( geo, mat );
		mesh.frustumCulled = false;
		mesh.castShadow = false;
		mesh.receiveShadow = false;
		mesh.renderOrder = 10;
		mesh.layers.set( LAYERS.TRANSPARENT );
		mesh.name = 'BreakerLips';
		// velocity: world positions with no motion of their own -> camera-only reprojection (static)
		mesh.staticVelocity = true;

	}

}

// Shoreline stations along the main beach: evenly spaced along the (smoothed) shoreline, each with
// the unit direction toward the sea. Returns { data: Float32Array(n * 4) (x, z, nx, nz), count, spacing }.
export function buildStations( terrain, { x0 = - 175, x1 = 195, spacing = 0.6 } = {} ) {

	// shoreline z(x): first land found marching north from the water
	const pts = [];
	for ( let x = x0; x <= x1; x += 0.5 ) {

		if ( terrain.heightAt( x, 12 ) > - 0.3 ) continue; // not open water in front
		let z = 12, zs = null;
		for ( ; z > - 110; z -= 0.5 ) {

			if ( terrain.heightAt( x, z ) > 0 ) {

				let lo = z, hi = z + 0.5; // land at lo, water at hi
				for ( let k = 0; k < 16; k ++ ) {

					const mid = ( lo + hi ) * 0.5;
					if ( terrain.heightAt( x, mid ) > 0 ) lo = mid; else hi = mid;

				}

				zs = ( lo + hi ) * 0.5;
				break;

			}

		}

		if ( zs !== null ) pts.push( [ x, zs ] );

	}

	// break into continuous runs, keep the longest (the main beach)
	let best = [], run = [];
	for ( let k = 0; k < pts.length; k ++ ) {

		if ( run.length && ( Math.abs( pts[ k ][ 1 ] - run[ run.length - 1 ][ 1 ] ) > 3 || pts[ k ][ 0 ] - run[ run.length - 1 ][ 0 ] > 1.01 ) ) {

			if ( run.length > best.length ) best = run;
			run = [];

		}

		run.push( pts[ k ] );

	}

	if ( run.length > best.length ) best = run;

	// smooth the polyline (the transects should not follow every wiggle of the waterline)
	let sm = best.map( ( p ) => [ p[ 0 ], p[ 1 ] ] );
	for ( let it = 0; it < 30; it ++ ) {

		const nx = sm.map( ( p, k ) => {

			if ( k === 0 || k === sm.length - 1 ) return p;
			return [ p[ 0 ], ( sm[ k - 1 ][ 1 ] + 2 * p[ 1 ] + sm[ k + 1 ][ 1 ] ) * 0.25 ];

		} );
		sm = nx;

	}

	// resample by arc length
	const out = [];
	let acc = 0, next = 0;
	for ( let k = 1; k < sm.length; k ++ ) {

		const [ ax, az ] = sm[ k - 1 ], [ bx, bz ] = sm[ k ];
		const seg = Math.hypot( bx - ax, bz - az );
		while ( next <= acc + seg ) {

			const t = ( next - acc ) / seg;
			const x = ax + ( bx - ax ) * t, z = az + ( bz - az ) * t;
			// normal toward the sea (+z side of a west->east polyline)
			const tx = ( bx - ax ) / seg, tz = ( bz - az ) / seg;
			out.push( x, z, - tz, tx );
			next += spacing;

		}

		acc += seg;

	}

	return { data: new Float32Array( out ), count: out.length / 4, spacing };

}
