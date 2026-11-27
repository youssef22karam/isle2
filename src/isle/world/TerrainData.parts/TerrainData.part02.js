					grass[ k ] = Math.round( g * 255 );
					H[ k ] = h + 0.12 * g * smoothstep( 2.2, 3.2, depth );

				}

				// rubble heads: sparse knobbly patches, more of them toward the rocky coasts
				const rw = smoothstep( 1.8, 3.0, depth ) * ( 1 - smoothstep( 11, 14, depth ) ) * keep;
				if ( rw > 0 ) {

					const b = n3.noise( x / 13 + 9.1, z / 13 - 2.2 ) + n.noise( x / 4.3, z / 4.3 ) * 0.3 + r0 * 0.35;
					const m = smoothstep( 0.52, 0.66, b ) * rw * ( 1 - g * 0.6 );
					if ( m > 0 ) {

						rubble[ k ] = Math.round( m * 255 );
						const knob = 0.5 + 0.5 * n2.ridged( x / 2.3, z / 2.3, 2 );
						H[ k ] = H[ k ] + 0.38 * m * knob * smoothstep( 2.4, 3.4, depth );

					}

				}

			}

		}

	}

	// rock / sand / gully masks from the final shape
	_masks( H, D, R0, BZ, CV ) {

		const res = RES, o = this.origin, n2 = this.noise2, n3 = this.noise3;
		const rock = this.rock, sand = this.sand, gully = this.gully;
		for ( let j = 1; j < res - 1; j ++ ) {

			const z = o + j + 0.5;
			for ( let i = 1; i < res - 1; i ++ ) {

				const k = j * res + i;
				const h = H[ k ];
				const d = D[ k ];
				const r0 = R0[ k ];
				if ( h < - 14 ) {

					rock[ k ] = r0 * ( 1 - smoothstep( 80, 260, d ) );
					sand[ k ] = 255;
					continue;

				}

				const x = o + i + 0.5;
				const gx = H[ k + 1 ] - H[ k - 1 ], gz = H[ k + res ] - H[ k - res ];
				const slope = Math.sqrt( gx * gx + gz * gz ) * 0.5;
				const bz = BZ[ k ];
				const nz = n2.noise( x / 23, z / 23 ) * 0.5 + n3.noise( x / 7, z / 7 ) * 0.25;

				// bare rock: steep faces, the rocky coast band, the seabed below cliffs
				// near the rocky shore even moderately steep ground is bare (sea cliffs, spray)
				const seaCliff = d < 0 ? r0 * ( 1 - smoothstep( 6, 38, - d ) ) : 0;
				const s0 = 1.45 - 0.75 * seaCliff + nz * 0.35;
				let steep = smoothstep( s0, s0 + 0.35, slope );
				// gully floors keep their soil and plants; spurs and faces between them go bare
				if ( steep > 0 && j > 5 && i > 5 && j < res - 6 && i < res - 6 ) {

					const cav = ( H[ k + 5 ] + H[ k - 5 ] + H[ k + 5 * res ] + H[ k - 5 * res ] - 4 * h ) / 25;
					steep *= 1 - 0.85 * smoothstep( 0.01, 0.08, cav );

				}
				const coast = d < 0 ? r0 * ( 1 - smoothstep( 2, 16 + nz * 12, - d ) ) : r0 * ( 1 - smoothstep( 80, 260, d ) );
				let rk = Math.max( steep, coast * ( 0.75 + nz * 0.5 ) );
				// rounded outcrops (detail pass bumps): convex and steep-ish
				if ( j > 3 && i > 3 && j < res - 4 && i < res - 4 ) {

					const lap = ( H[ k + 3 ] + H[ k - 3 ] + H[ k + 3 * res ] + H[ k - 3 * res ] - 4 * h ) / 9;
					rk = Math.max( rk, smoothstep( 0.55, 0.9, slope ) * smoothstep( - 0.12, - 0.3, lap ) * ( 1 - bz ) * 0.8 );

				}
				rock[ k ] = clamp( rk * ( 1 - this.scarp[ k ] / 255 ), 0, 1 );

				// loose sand: the bay beach and dunes, small coves, the seabed
				let sd;
				if ( d >= 0 ) sd = 1 - smoothstep( 0.4, 0.8, rk );
				else {

					const e = - d;
					// the beach proper runs just past the berm crest; behind it sandy soil grades
					// into the village lawn, while the dunes away from the village stay sandy
					const beach = bz * ( 1 - smoothstep( 36 + nz * 10, 50 + nz * 14, e ) );
					const backBeach = bz * 0.45 * ( 1 - smoothstep( 60 + nz * 20, 100 + nz * 20, e ) );
					const vd = Math.hypot( ( x - VILLAGE.x ) * 0.8, z - VILLAGE.z );
					const away = smoothstep( 80, 120, vd ) * smoothstep( 14, 30, Math.abs( x - WORLD.pier.x ) );
					const dune = bz * away * ( 1 - smoothstep( 4.5 + nz * 2, 7 + nz * 2, h ) ) * ( 1 - smoothstep( 110, 140, e ) );
					const cove = ( 1 - smoothstep( 6, 16, e ) ) * ( 1 - smoothstep( 0.25, 0.5, rk ) ) * ( 1 - smoothstep( 1.8, 3.2, h ) ) * ( 1 - smoothstep( 0.12, 0.3, slope ) );
					sd = Math.max( beach, backBeach, dune, cove ) * ( 1 - smoothstep( 0.3, 0.6, slope ) );

				}

				sand[ k ] = Math.round( clamp( sd, 0, 1 ) * 255 );
				gully[ k ] = Math.round( smoothstep( 4, 18, - CV[ k ] ) * 255 );

			}

		}

	}

	// ------------------------------------------------------------------ edits / queries

	// flatten a circular pad (for building foundations)
	flatten( x, z, radius, height, falloff = 4 ) {

		const { res, texel, origin } = this;
		const r = radius + falloff;
		this.pads.push( { x, z, radius, height } );
		const i0 = Math.max( 0, Math.floor( ( x - r - origin ) / texel ) ), i1 = Math.min( res - 1, Math.ceil( ( x + r - origin ) / texel ) );
		const j0 = Math.max( 0, Math.floor( ( z - r - origin ) / texel ) ), j1 = Math.min( res - 1, Math.ceil( ( z + r - origin ) / texel ) );
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			const px = origin + ( i + 0.5 ) * texel, pz = origin + ( j + 0.5 ) * texel;
			const d = Math.hypot( px - x, pz - z );
			const t = 1 - smoothstep( radius, r, d );
			const k = j * res + i;
			this.heights[ k ] = lerp( this.heights[ k ], height, t );
			this.rock[ k ] *= 1 - t;

		}

	}

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

	// distance (m) from (x, z) to the nearest footpath edge (negative inside a path)
	pathDistance( x, z ) {

		let best = Infinity;
		for ( const p of PATHS ) best = Math.min( best, polylineDistance( p.pts, x, z )[ 0 ] - p.w );
		return best;

	}

	// min/max pyramid for CDLOD culling bounds
	buildMinMax() {

		const tile = 8; // texels per tile at the finest level
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
		// coarser levels: level l has n >> l tiles per side
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
		// pick the pyramid level where the box spans only a few tiles per side
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

}
