
// Run-up of the most recent wave at a point on the beach (distances in metres up the beach face).
// The run-up is compared with the height of the sand (converted with the nominal beach slope), so
// the front is exact at the waterline and follows the contours of the sand. sh: terrainShoreSample( xz ).
fn shoreSwashRunup( sh: vec4f, along: f32, groundH: f32 ) -> ShoreRunup {
	let Tp = shoreP.period;
	let exposure = length( vec2f( sh.y, sh.z ) );
	let Ts = sh.w;
	let inland = max( groundH - frame.seaLevel, 0.0 ) / SHORE_BEACH_SLOPE;
	let ss = ( frame.time - Ts ) / Tp + shoreWobble( along );
	let ms = floor( ss );
	let tau = ss - ms; // 0..1 time since that wave's bore reached the shoreline
	let Am = shoreWaveAmp( ms, along );
	// vertical run-up ~ H on this gentle beach, converted to a horizontal excursion
	let RhMax = Am * 2.1 * shoreP.runup * sat( exposure * 1.4 ) / SHORE_BEACH_SLOPE;
	// decelerating uprush, then a backwash that starts slowly and accelerates as the sheet drains
	let su = sat( tau / SHORE_SWASH_UP );
	let sb = sat( ( tau - SHORE_SWASH_UP ) / SHORE_SWASH_DOWN );
	let isUp = tau < SHORE_SWASH_UP;
	let Rh = select( 1.0 - pow( sb, 1.6 ), 1.0 - pow( 1.0 - su, 1.5 ), isUp ) * RhMax - 0.3;
	// the front is lobed, not a straight line: each wave runs up a little differently along the beach
	let lobes = sin( along * 0.61 + ms * 2.3 ) * 0.5 + sin( along * 1.73 + ms * 5.1 ) * 0.3 + sin( along * 4.3 + ms * 1.7 ) * 0.2;
	// the backwash never quite exposes the lower beach face: a film of water always covers the
	// first decimetres past the shoreline, so the sea never meets the sand along mesh triangles
	let Rt = max( Rh + lobes * ( max( Rh, 0.0 ) * 0.07 + 0.35 ), 0.35 ) * shoreP.enabled;
	return ShoreRunup( tau, Rt, inland, RhMax, su, sb, isUp );
}

// Water film thickness clipped at the leading edge of the swash sheet, for the water shader's
// edge fade: min( thickness, distance to the front (m) * 0.08 ). Only evaluated where the film is
// thin, so the sheet ends on the analytic front instead of the mesh triangles at ~no cost.
fn shoreSwashEdge( p: vec2f, t: f32 ) -> vec4f {
	var out = vec4f( t, 1e3, 0.0, 0.0 );
	if ( t < 0.3 ) {
		let g = terrainHeightAt( p );
		if ( g > frame.seaLevel - 0.8 ) {
			let ph = shorePhaseAt( p );
			let r = shoreSwashRunup( ph.sh, ph.along, g );
			let front = r.Rt - r.inland;
			// The lapping region reaches down the beach face past where the sea's edge sits in the trough
			// of the backwash (it stopped at sea level: a strip in between with a straight edge across the
			// draining water), and fades in from there and from 0.3 m of film instead of switching on.
			// The front distance is divided by the weight so the effects at the front recede with it.
			let w = smoothstep( frame.seaLevel - 0.8, frame.seaLevel - 0.4, g ) * smoothstep( 0.3, 0.15, t );
			if ( w > 0.0 ) {
				out = vec4f( mix( t, min( t, front * 0.08 ), w ), front / max( w, 1e-3 ), r.tau, r.Rt * w );
			}
		}
	}
	return out;
}

fn shoreSwashClip( p: vec2f, t: f32 ) -> f32 {
	return shoreSwashEdge( p, t ).x;
}

// ------------------------------------------------------------ evaluate()
// Returns displacement relative to (xz, seaLevel), foam, breaking indicator and the
// swash surface level (absolute height) for this point. shoreEvaluate (withNormal, the water mesh) also
// gives face: 1 on the clear concave face of a plunging wave, roller: relief of the whitewater (m).
// shoreEvaluateWorld: the shore simulation's view (a fixed world point instead of a water parcel): foam and
// height are those of the water shown at xz, the displacement is not meaningful.
${ evaluateCode( 'shoreEvaluate', 'normal' ) }
${ evaluateCode( 'shoreEvaluateNoNormal', 'plain' ) }
${ evaluateCode( 'shoreEvaluateWorld', 'world' ) }
`;

	}

	// ------------------------------------------------------------ cheap wave direction lookup

	// Low-resolution texture of the wave direction and exposure over a region (one bilinear
	// fetch from 4 loads instead of the 4 exact loads of the shore field for each of 4 corners) for
	// per-pixel effects near the beach. region: { min: Vector2, size }. WGSL: shoreDirAt( xz ) ->
	// vec3f( dir.x, dir.z, exposure ).
	buildDirTexture( { min, size, res = 128 } ) {

		// the shore field (T, dirX, dirZ, exposure / swash time) as float data on the CPU
		const T = this.terrain;
		const field = T.shoreField || null;
		const data = field ? field.data : T.shoreData || T.shoreTexture?.image?.data || T.shoreTexture?.pendingData;
		const fres = field ? field.res : T.shoreRes;
		if ( ! data || ! fres ) {

			console.warn( 'ShoreWaves.buildDirTexture: no shore field data on the terrain; using terrainShoreSample instead' );
			return null;

		}

		const origin = T.origin, tsize = T.size;
		const out = new Float32Array( res * res * 4 );
		for ( let j = 0; j < res; j ++ ) for ( let i = 0; i < res; i ++ ) {

			const x = min.x + ( i + 0.5 ) / res * size, z = min.y + ( j + 0.5 ) / res * size;
			const fx = Math.min( Math.max( ( x - origin ) / tsize * fres - 0.5, 0 ), fres - 1.001 );
			const fz = Math.min( Math.max( ( z - origin ) / tsize * fres - 0.5, 0 ), fres - 1.001 );
			const i0 = Math.floor( fx ), j0 = Math.floor( fz ), tx = fx - i0, tz = fz - j0;
			const at = ( c ) => {

				const a = data[ ( j0 * fres + i0 ) * 4 + c ], b = data[ ( j0 * fres + i0 + 1 ) * 4 + c ];
				const cc = data[ ( ( j0 + 1 ) * fres + i0 ) * 4 + c ], d = data[ ( ( j0 + 1 ) * fres + i0 + 1 ) * 4 + c ];
				return ( a * ( 1 - tx ) + b * tx ) * ( 1 - tz ) + ( cc * ( 1 - tx ) + d * tx ) * tz;

			};

			const dx = at( 1 ), dz = at( 2 );
			const e = Math.hypot( dx, dz ) || 1e-4;
			const k = ( j * res + i ) * 4;
			out[ k ] = dx / e;
			out[ k + 1 ] = dz / e;
			out[ k + 2 ] = Math.min( 1, e * 1.4 );
			out[ k + 3 ] = 1;

		}

		// float data, read with exact loads: no sampler binding (fragment shaders are at their sampler limit)
		const t = new Texture( { label: 'shoreDir', width: res, height: res, format: 'rgba32float', data: out } );
		this.dirTexture = t;
		this.dirMin.value.copy( min );
		this.dirSize.value = size;
		this.uniforms.fields.dirOn.value = 1;
		this.dirRes = res;
		return t;

	}

}
