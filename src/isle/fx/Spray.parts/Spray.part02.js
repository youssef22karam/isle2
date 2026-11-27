	let distFade = smoothstep( mat.maxDistance, mat.maxDistance * 0.55, dist ) * select( smoothstep( 0.6, 3.0, dist ), 1.0, water );
	let a = baseA * fadeIn * fadeOut * cover * distFade * mat.intensity;

	o.vUV = corner;
	o.vCol = vec4f( col, a );
	// x: kind + 0.45 * life fraction (the kind tests below have 0.5 of margin)
	o.vMisc = vec4f( kind + sat( t ) * 0.45, info.z, size, fract( info.w ) );

	// dead particles collapse off-screen
	v.useWorld = true;
	v.worldPos = select( vec3f( 0.0, -1e5, 0.0 ), world, alive && a > 1e-4 );
	v.worldNormal = Vd;
`,
			// motion vectors: camera-only reprojection of the world position (the default for a
			// world-space vertex without a previous position), weighted by coverage in the late pass
			output: /* wgsl */`
	let uv = in.vs.vUV;
	let vMisc = in.vs.vMisc;
	let kind = vMisc.x;
	let isDrop = kind < 0.5;
	let isLig = kind > 1.5 && kind < 2.5;
	let isSheet = kind > 2.5;
	let isClear = kind > 3.5;
	let t = sat( fract( kind ) / 0.45 ); // life fraction
	let r2 = dot( uv, uv );
	let sd = vec2f( vMisc.w, vMisc.w * 1.7 );
	// drop: gaussian streak; ligament: a slightly sharper, beaded blob
	let drop = max( exp( r2 * - 3.5 ) - 0.03, 0.0 );
	let lig = max( exp( r2 * - 4.5 ) * ( sin( uv.y * 5.0 + vMisc.w * 40.0 ) * 0.2 + 0.9 ) - 0.03, 0.0 );
	// torn sheet: noise streaked along the motion (uv.y), eroded from its edges inward and more and
	// more as it ages, so it tears into strands and fragments instead of shrinking. Thick parts are
	// dense white water, the torn edges thin and translucent.
	let env = sat( 1.0 - r2 );
	let fib = textureSample( sprayPuff, smpLinearRepeat, vec2f( uv.x * 0.5, uv.y * 0.26 ) + sd ).x;
	let fine = textureSample( sprayPuff, smpLinearRepeat, vec2f( uv.x * 1.2, uv.y * 0.6 ) + sd * 2.3 ).x;
	let field = fib * 0.6 + fine * 0.4 + ( env - 0.55 ) * 0.75 - smoothstep( 0.8, 1.0, r2 );
	// a torn sheet only a few pixels across can't show its tears: a solid white dot, and a cluster of
	// them reads as cauliflower puffs. Small on screen, it is drawn thinner and more torn: a far
	// splash-up is a ragged, see-through burst
	let farK = smoothstep( 14.0, 3.0, in.vs.vFwd.w ) * select( 0.0, 1.0, isSheet && ! isClear );
	let erode = mix( 0.26, 0.7, t ) + farK * 0.16;
	let dens = sat( ( field - erode ) * 3.0 );
	// torn edges are thin, translucent water: soft and see-through, the core dense white
	let torn = smoothstep( erode - 0.04, erode + 0.2, field ) * ( dens * 0.45 + 0.55 );
	// ... which breaks up into a cluster of drops: many small dots in a ragged envelope that thins
	// out as it ages (sub-pixel drops average out through the mipmaps: never a solid blob)
	let dots = textureSample( sprayDots, smpLinearRepeat, uv * vec2f( 0.5, 0.32 ) + sd * 3.7 ).x;
	let swarm = dots * smoothstep( 0.25, 0.55, fib + env * 0.45 - t * 0.2 ) * ( 1.0 - t * 0.5 );
	let sheet = max( torn * ( 1.0 - smoothstep( 0.15, 0.6, t ) ), swarm );
	// mist: a soft veil of low-frequency noise that drifts and thins, never a disc
	let m1 = textureSample( sprayPuff, smpLinearRepeat, uv * 0.2 + sd ).x;
	let m2 = textureSample( sprayPuff, smpLinearRepeat, uv * 0.55 + sd * 3.1 ).x;
	let veil = smoothstep( 0.28, 0.8, m1 * 0.7 + m2 * 0.3 + env * 0.3 - 0.12 ) * sqrt( env ) * ( 1.0 - t * 0.4 );
	let shape = select( select( select( veil, sheet, isSheet ), lig, isLig ), drop, isDrop );
	// self-shadowing inside thick sheets; the forward-scattered sun lights up the thin parts
	let shade = select( 1.0, 1.0 - dens * 0.15, isSheet && ! isClear );
	let glow = select( select( 1.0, 1.0 - dens * 0.6, isSheet ), 1.0 - dens * 0.3, isClear );

	// soft intersections: opaque scene depth and the water surface under the particle
	// (depth via exact texel loads; reversed-Z, view z negative in front of the camera)
	let dsz = vec2f( textureDimensions( spraySceneDepth ) );
	let q = vec2i( clamp( in.pixel * frame.invResolution, vec2f( 0.0 ), vec2f( 0.9999 ) ) * dsz );
	let sceneZ = - viewDepth( textureLoad( spraySceneDepth, q, 0 ) );
	let posViewZ = ( frame.view * vec4f( in.P, 1.0 ) ).z;
	let soft = vMisc.z * 1.5 + 0.03;
	let fadeScene = sat( ( posViewZ - sceneZ ) / soft );
	let fadeWater = sat( ( in.P.y - vMisc.y ) / ( soft * 0.6 ) + 0.15 );
	let aOut = in.vs.vCol.w * shape * fadeScene * fadeWater * ( 1.0 - farK * 0.4 );
	if ( aOut < 0.002 ) { discard; }
	r.color = vec4f( ( in.vs.vCol.rgb * shade + in.vs.vFwd.xyz * glow ) * aOut, aOut );
`,
		} );

		// the optional hooks (clouds, wave shadow) join the material on its first pipeline build
		const key = mat.pipelineKey;
		mat.pipelineKey = () => {

			if ( ! this._matHooked ) {

				this._matHooked = true;
				mat.modules = [ sprayCommon, this._hooks() ];

			}

			return key.call( mat );

		};

		this.material = mat;
		this.params = {
			intensity: mat.uniforms.intensity,
			maxDistance: mat.uniforms.maxDistance,
		};

		const mesh = this.mesh = new Mesh( geo, mat );
		mesh.count = this.N;
		mesh.frustumCulled = false;
		mesh.castShadow = false;
		mesh.receiveShadow = false;
		mesh.renderOrder = 20;
		mesh.layers.set( LAYERS.TRANSPARENT );
		mesh.name = 'Spray';

	}

}

// mipmapped rgba8 texture from CPU data (repeat wrap: sample with smpLinearRepeat)
function mipTexture( data, size, label ) {

	const tex = new Texture( { label, width: size, height: size, format: 'rgba8unorm', mips: true, usage: [ 'sample', 'copyDst', 'render' ], data, sampler: 'linearRepeat' } );
	tex.getGPU();
	generateMipmaps( tex );
	return tex;

}

// Small tileable value-noise texture for mist puffs (generated once on the CPU).
function makePuffTexture( size = 64 ) {

	const data = new Uint8Array( size * size * 4 );
	const rnd = ( i, j, o ) => {

		const s = Math.sin( ( i % o ) * 127.1 + ( j % o ) * 311.7 + o * 17.3 ) * 43758.5453;
		return s - Math.floor( s );

	};

	const vnoise = ( x, y, o ) => {

		const i = Math.floor( x ), j = Math.floor( y );
		const fx = x - i, fy = y - j;
		const ux = fx * fx * ( 3 - 2 * fx ), uy = fy * fy * ( 3 - 2 * fy );
		const a = rnd( i, j, o ), b = rnd( i + 1, j, o ), c = rnd( i, j + 1, o ), d = rnd( i + 1, j + 1, o );
		return ( a * ( 1 - ux ) + b * ux ) * ( 1 - uy ) + ( c * ( 1 - ux ) + d * ux ) * uy;

	};

	for ( let j = 0; j < size; j ++ ) for ( let i = 0; i < size; i ++ ) {

		let s = 0, a = 0.5, n = 0;
		for ( let o = 4; o <= 32; o *= 2 ) {

			s += vnoise( i / size * o, j / size * o, o ) * a;
			n += a;
			a *= 0.55;

		}

		const v = Math.max( 0, Math.min( 1, ( s / n - 0.2 ) * 1.6 ) );
		const k = ( j * size + i ) * 4;
		data[ k ] = data[ k + 1 ] = data[ k + 2 ] = Math.round( v * 255 );
		data[ k + 3 ] = 255;

	}

	return mipTexture( data, size, 'sprayPuff' );

}

// Tileable texture of scattered drops (r: coverage), for clusters of drops. Heavy-tailed radii: many
// tiny drops, a few large ones.
function makeDotsTexture( size = 128, count = 150 ) {

	const data = new Uint8Array( size * size * 4 );
	let seed = 12345;
	const rnd = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	const cov = new Float32Array( size * size );
	for ( let k = 0; k < count; k ++ ) {

		const cx = rnd() * size, cy = rnd() * size;
		const r = Math.min( 0.9 * Math.pow( 1 - rnd() * 0.97, - 0.55 ), 6 );
		const R = Math.ceil( r + 1.5 );
		for ( let dy = - R; dy <= R; dy ++ ) for ( let dx = - R; dx <= R; dx ++ ) {

			const x = ( ( Math.floor( cx ) + dx ) % size + size ) % size, y = ( ( Math.floor( cy ) + dy ) % size + size ) % size;
			const d = Math.hypot( Math.floor( cx ) + dx + 0.5 - cx, Math.floor( cy ) + dy + 0.5 - cy );
			const c = Math.max( 0, Math.min( 1, r + 0.5 - d ) );
			cov[ y * size + x ] = Math.max( cov[ y * size + x ], c );

		}

	}

	for ( let i = 0; i < size * size; i ++ ) {

		const v = Math.round( cov[ i ] * 255 );
		data[ i * 4 ] = data[ i * 4 + 1 ] = data[ i * 4 + 2 ] = v;
		data[ i * 4 + 3 ] = 255;

	}

	return mipTexture( data, size, 'sprayDots' );

}
