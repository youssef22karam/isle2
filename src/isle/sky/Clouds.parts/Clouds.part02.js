	let lit = smoothstep( -0.006, 0.006, mu + sqrt( max( alt, 0.0 ) * ${ f( 2 / EARTH_R ) } ) );
	return select( lit, 1.0, light.isMoon );
}

// cubic B-spline filtered texture lookup in 4 bilinear taps (GPU Gems 2, ch. 20): magnified cirrus fibres
// stay smooth instead of showing the bilinear texel grid (res: texels at mip 0)
fn cloudsBspline( uv: vec2f, lod: f32 ) -> vec4f {
	let size = ${ f( FIB_RES ) } / exp2( lod );
	let st = uv * size - 0.5;
	let i = floor( st );
	let fr = st - i;
	let f2 = fr * fr; let f3 = f2 * fr;
	let w0 = ( - f3 + f2 * 3.0 - fr * 3.0 + 1.0 ) / 6.0;
	let w1 = ( f3 * 3.0 - f2 * 6.0 + 4.0 ) / 6.0;
	let w3 = f3 / 6.0;
	let w2 = 1.0 - w0 - w1 - w3;
	let g0 = w0 + w1; let g1 = w2 + w3;
	let p0 = ( i - 0.5 + w1 / g0 ) / size; let p1 = ( i + 1.5 + w3 / g1 ) / size;
	return textureSampleLevel( cloudsFibTex, smpLinearRepeat, vec2f( p0.x, p0.y ), lod ) * ( g0.x * g0.y )
		+ textureSampleLevel( cloudsFibTex, smpLinearRepeat, vec2f( p1.x, p0.y ), lod ) * ( g1.x * g0.y )
		+ textureSampleLevel( cloudsFibTex, smpLinearRepeat, vec2f( p0.x, p1.y ), lod ) * ( g0.x * g1.y )
		+ textureSampleLevel( cloudsFibTex, smpLinearRepeat, vec2f( p1.x, p1.y ), lod ) * ( g1.x * g1.y );
}

fn cloudsToWind( v: vec2f ) -> vec2f { return vec2f( v.x * CL_HC + v.y * CL_HS, v.y * CL_HC - v.x * CL_HS ); }

// anisotropic filtering: n taps along the long axis of the footprint at the mip of its short axis
fn cloudsFibres( q: vec2f, fA: vec2f, fB: vec2f, tile: f32, rot: f32 ) -> vec4f {
	let cr = cos( rot ); let sr = sin( rot );
	let wq = cloudsToWind( q ); let wa = cloudsToWind( fA ); let wb = cloudsToWind( fB );
	let uv = vec2f( wq.x * cr + wq.y * sr, wq.y * cr - wq.x * sr ) / tile;
	let a = vec2f( wa.x * cr + wa.y * sr, wa.y * cr - wa.x * sr ) / tile;
	let b = vec2f( wb.x * cr + wb.y * sr, wb.y * cr - wb.x * sr ) / tile;
	let la = length( a ) * ${ f( FIB_RES ) }; let lb = length( b ) * ${ f( FIB_RES ) };
	let major = select( b, a, la > lb );
	const n = 3;
	let lod = max( log2( max( min( la, lb ), max( la, lb ) / f32( n ) ) ), 0.0 );
	var sum = vec4f( 0.0 );
	for ( var i = 0; i < n; i++ ) {
		sum += cloudsBspline( uv + major * ( ( f32( i ) + 0.5 ) / f32( n ) - 0.5 ), lod );
	}
	return sum / f32( n );
}

// Cirrus veil seen along rd: vec4( radiance, transmittance ). A thin sheet on a curved-earth
// shell, so its fibres converge toward the horizon in true perspective. Its coverage varies
// only over hundreds of km (clearer and thicker parts of the sky, no outlines); long, gently
// curved fibres follow the upper wind and give a low contrast texture. The fibre texture is
// filtered anisotropically with the footprint of one pixel (pxAngle, radians), which turns
// distant fibres into a smooth veil. Lighting: single scattering by ice crystals (strong
// forward peak: bright near the sun, a faint 22 degree halo) plus multiple scattering and sky
// light; lit by the sun from below its horizon for a while after sunset.
fn cloudsHigh( rd: vec3f, pxAngle: f32 ) -> vec4f {
	let H = cloudsParams.cirrusAlt;
	let light = cloudsKeyLight( 9.0 );
	let sunDir = light.dir;
	let cosT = dot( rd, sunDir );

	// geometry: hit point, local incidence, pixel footprint on the sheet (across the view and
	// along it, stretched by 1 / mu)
	let t = cloudsShell( cloudsParams.camY, rd, H );
	let pxz = rd.xz * t;
	let up = normalize( vec3f( pxz.x / CL_EARTH_R, 1.0, pxz.y / CL_EARTH_R ) );
	let mu = max( dot( rd, up ), 0.02 );
	let radial = normalize( rd.xz + vec2f( 1e-6, 0.0 ) );
	let fA = vec2f( - radial.y, radial.x ) * ( t * pxAngle );
	let fB = radial * ( t * pxAngle / mu );
	let q = pxz + cloudsParams.camXZ - cloudsParams.hOffset;

	// coverage: patches of 5 - 50 km with clear gaps, modulated over hundreds of km, broad bands
	let syn = textureSampleLevel( cloudsSynTex, smpLinearRepeat, cloudsToWind( q ) * ${ f( 1 / SYN_SIZE ) }, 0.0 );
	let cov = smoothstep( 0.15, 0.85, syn.x ) * smoothstep( 0.4, 0.72, syn.z ) * ( syn.y * 0.4 + 0.6 );
	// fibres at two scales (hides the tiling of the texture)
	let f1 = cloudsFibres( q, fA, fB, ${ f( FIB_TILE ) }, 0.0 );
	let f2 = cloudsFibres( q, fA, fB, ${ f( FIB_TILE * 2.3 ) }, 0.5 );
	let fib = f1.x * 0.6 + f2.x * 0.4;
	let veil = f1.y * 0.5 + f2.y * 0.5;
	// vertical optical depth: faint wisps (opacity mostly 0.05 - 0.2 at the default amount) over
	// a thinner veil
	let amount = cloudsParams.cirrus * ( cloudsParams.coverage * 0.5 + 0.78 );
	let tau = amount * 0.4 * cov * ( fib * 0.75 + 0.25 ) * ( veil * 0.4 + 0.8 );
	// slant path, bounded so the veil doesn't turn into a white band at the horizon
	let alpha = 1.0 - exp( - tau / max( mu, 0.25 ) );

	// lighting: the key light at the sheet (sunset colours depend on the altitude)
	let muS = dot( sunDir, up );
	let E = select( atmosphereSampleTransmittance( 6360.0 + H / 1000.0, muS ) * atmosphereParams.sunIlluminance, light.E, light.isMoon )
		* cloudsEarthShadow( light, H, pxz );
	// ice: strong forward peak, a faint 22 degree halo, some backscatter; thin: mostly single
	// scattering, a little multiply scattered light
	let hd = ( acos( clamp( cosT, -1.0, 1.0 ) ) - 0.384 ) / 0.02;
	let halo = exp( - hd * hd ) * 0.04;
	let phase = clPhaseHG( cosT, 0.85 ) * 0.4 + clPhaseHG( cosT, 0.3 ) * 0.35 + clPhaseHG( cosT, -0.15 ) * 0.25 + halo;
	let Ts = exp( tau * -0.5 / max( muS, 0.1 ) );
	let L = ( E * ( phase * Ts + ( 1.0 - Ts ) * 0.06 ) + frame.skyIrradiance * 0.9 ) * alpha;
	// aerial perspective: haze in front of the sheet shows sky light where the sheet hides it
	let tr = exp( t * ${ f( - 0.25 / AP_DIST ) } );
	let skyL = atmosphereSkyLuminance( rd );
	return vec4f( L * tr + skyL * alpha * ( 1.0 - tr ), 1.0 - alpha );
}

// Samples lie on a lattice along the ray, shared by all rays and jittered per frame: steps of
// ds in distance bands ( [0, 5), [5, 10), [10, 20), [20, 40), 40+ km, ds doubling), fine points
// every ds, coarse points every coarse fine points. Jumps over empty space snap onto it, so
// neighbouring pixels always sample the clouds at consistent positions (arbitrary landing
// points after a jump would average into contour lines)
const CL_B0: f32 = 2500.0;
fn cloudsBand( t: f32 ) -> f32 { return clamp( floor( log2( max( t, CL_B0 ) / CL_B0 ) ), 0.0, 4.0 ); }
fn cloudsBandStart( b: f32 ) -> f32 { return select( exp2( b ) * CL_B0, 0.0, b == 0.0 ); }
fn cloudsPosMod( x: f32, c: f32 ) -> f32 { return x - floor( x / c ) * c; }

struct CloudsMarch { L: vec3f, T: f32, depth: f32 };
${ marchWGSL( 'View', { maxSteps: 200, maxDist: 50000, ds0: 24, dsMax: 120, coarse: 4, lightSteps: [ 12, 50, 140, 350, 900, 1800 ], lightDetail: 3, detail: true, ambient: 1.2, pxAngle: 'cloudsParams.camTan.y * 2.0 / cloudsParams.displayH' } ) }
${ marchWGSL( 'Pano', { maxSteps: 56, maxDist: 50000, ds0: 60, dsMax: 320, coarse: 2, lightSteps: [ 120, 500 ], lightDetail: 0, detail: false, ambient: 1.2, pxAngle: f( 2 * PI / PANO_W ) } ) }
`,
		} );

		// cloud shadow only (one texture, no sampler): for the lighting hooks of every lit material
		this.shadowModule = new ShaderModule( {
			name: 'cloudsShadow',
			deps: [ commonModule ],
			uniforms: this.params,
			uniformName: 'cloudsParams',
			bindings: { cloudsShadowMap: { texture: this.shadowMap } },
			code: /* wgsl */`
// cloud shadow transmittance (1 = clear) at a world position. Manual bilinear filtering of an
// unfilterable texture: costs no sampler in the (sampler hungry) scene materials.
fn cloudsShadowTap( i: vec2i ) -> f32 { return textureLoad( cloudsShadowMap, clamp( i, vec2i( 0 ), vec2i( ${ SHADOW_RES - 1 } ) ), 0 ).x; }
fn cloudsShadow( worldXZ: vec2f ) -> f32 {
	let uv = ( worldXZ - cloudsParams.shadowCenter ) / cloudsParams.shadowSize + 0.5;
	let st = uv * ${ f( SHADOW_RES ) } - 0.5;
	let i0 = vec2i( floor( st ) );
	let fr = fract( st );
	let s = mix( mix( cloudsShadowTap( i0 ), cloudsShadowTap( i0 + vec2i( 1, 0 ) ), fr.x ), mix( cloudsShadowTap( i0 + vec2i( 0, 1 ) ), cloudsShadowTap( i0 + vec2i( 1, 1 ) ), fr.x ), fr.y );
	// no data outside the map: fade to unshadowed at its border
	let e = abs( uv - 0.5 );
	let inside = smoothstep( 0.5, 0.42, max( e.x, e.y ) );
	return mix( 1.0, s, cloudsParams.shadowStrength * inside );
}
`,
		} );

		// public sampling module (sky, environment, water, materials)
		this.module = new ShaderModule( {
			name: 'clouds',
			deps: [ commonModule, helpers, this.shadowModule ],
			uniforms: this.params,
			uniformName: 'cloudsParams',
			bindings: {
				cloudsPanorama: { texture: this.panorama },
				cloudsView: { texture: () => this.viewTex },
			},
			code: /* wgsl */`
${ catmullRomWGSL( 'cloudsViewCatmullRom', 'cloudsView' ) }

// vec4(rgb in-scattered radiance, a transmittance) for a view direction (panorama)
fn cloudsSample( dir: vec3f ) -> vec4f {
	let az = atan2( dir.z, dir.x );
	let u = fract( az / ${ f( 2 * PI ) } );
	let elev = - acos( clamp( dir.y, -1.0, 1.0 ) ) + ${ f( PI / 2 ) };
	let t = clamp( ( elev + ${ f( ( 4 / 180 ) * PI ) } ) / ${ f( ( 94 / 180 ) * PI ) }, 0.0, 1.0 );
	let v = sqrt( t );
	let s = textureSampleLevel( cloudsPanorama, smpLinearRepeat, vec2f( u, v ), 0.0 );
	// below the panorama range: no clouds
	let below = smoothstep( -0.07, -0.03, dir.y );
	return vec4f( s.rgb * below, mix( 1.0, s.a, below ) );
}

// Full resolution clouds for the main background. The view texture is looked up with the camera
// it was traced with (it can lag behind: underwater frames skip the tracing); directions outside
// it, or a texture without data yet (startup, resize), fall back to the panorama, so the sky can
// never show empty texels
// Transmittance for the sun's disc behind the clouds. The cloud march stops once less than 0.3 % of
// the light gets through and reports that remainder, which (noisy from frame to frame) let a
// clamped sun disc of 2500x the sky shine and sparkle through thick cloud: below ~0.4 % it is dark.
fn cloudsSunTransmittance( T: f32 ) -> f32 { return T * smoothstep( 0.004, 0.04, T ); }

fn cloudsSampleView( dir: vec3f ) -> vec4f {
	let uv = cloudsProject( dir, cloudsParams.viewRight, cloudsParams.viewUp, cloudsParams.viewFwd, cloudsParams.viewTan );
	let inside = cloudsParams.viewValid > 0.5 && dot( dir, cloudsParams.viewFwd ) > 0.01 && uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
	if ( inside ) {
		// bicubic (Catmull-Rom) upsampling of the half resolution history keeps the edges crisp
		let v = max( cloudsViewCatmullRom( uv, cloudsParams.viewSize ), vec4f( 0.0 ) );
		let above = smoothstep( -0.05, -0.03, dir.y );
		return vec4f( v.rgb * above, mix( 1.0, min( v.a, 1.0 ), above ) );
	}
	return cloudsSample( dir );
}

`,
		} );

	}

	// ------------------------------------------------------------ kernels

	_buildKernels() {

		const noise = new ShaderModule( { name: 'cloudsNoise', deps: [ commonModule ], code: NOISE_WGSL } );
		const helpers = this.helpersModule;
		const K = ( label, modules, bindings, code, wg = [ 8, 8, 1 ] ) => new ComputeKernel( { label, modules, bindings, code, workgroupSize: wg } );
		const MAIN = '@compute @workgroup_size( WG_X, WG_Y, WG_Z ) fn main( @builtin( global_invocation_id ) gid: vec3u )';

		this._noiseKernels = {
			// shape: r = billowy base shape (worley fbm dilated by perlin), gb = low frequency swirl for
			// the detail lookups
			shape: K( 'Cloud Shape Noise', [ noise ], { outTex: { storageTexture: this.shapeTex } }, /* wgsl */`${ MAIN } {
	let p = ( vec3f( gid ) + 0.5 ) / ${ f( SHAPE_RES ) };
	let b = clBillows( p, 4.0 );
	let pn = clPerlinFbm( p, 4.0 ) * 0.9 + 0.5;
	// perlin-worley: remap( perlin, 0, 1, worley, 1 ) keeps the billows, breaks their regularity
	let pw = b + sat( pn ) * ( 1.0 - b ) * 0.5;
	let base = sat( ( pw - 0.42 ) / 0.5 );
	let cx = clGnoise( p + 0.31, 4.0 ) * 0.7 + 0.5;
	let cz = clGnoise( p + 0.67, 4.0 ) * 0.7 + 0.5;
	textureStore( outTex, gid, vec4f( base, sat( cx ), sat( cz ), 1.0 ) );
}`, [ 4, 4, 4 ] ),

			// detail: worley fbm distance (0 at the centre of a lump, high in the creases between lumps) at
			// three frequencies (sky-pro-webgpu's base noise profile: cells 4 / 8 / 16 per period, octaves x2, x4)
			detail: K( 'Cloud Detail Noise', [ noise ], { outTex: { storageTexture: this.detailTex } }, /* wgsl */`
fn fbmW( p: vec3f, c: f32 ) -> f32 { return clWorley3( p, c ) * 0.625 + clWorley3( p, c * 2.0 ) * 0.25 + clWorley3( p, c * 4.0 ) * 0.125; }
${ MAIN } {
	let p = ( vec3f( gid ) + 0.5 ) / ${ f( DETAIL_RES ) };
	textureStore( outTex, gid, vec4f( sat( fbmW( p, 4.0 ) ), sat( fbmW( p, 8.0 ) ), sat( fbmW( p, 16.0 ) ), 1.0 ) );
}`, [ 4, 4, 4 ] ),

			// ---- weather: r = small cell profile, g = its top (fraction of the layer), b = turrets,
			// a = big cell profile
			weather: K( 'Cloud Weather', [ noise ], { outTex: { storageTexture: this.weatherTex } }, /* wgsl */`
// cells of varying size: max over cells of a blob that fades out at its random radius,
// cells switch on where the mesoscale field allows. returns vec2( blob, its size )
fn blobs( p: vec2f, cells: vec2f, meso: f32, seed: f32 ) -> vec2f {
	let q = p * cells;
	let ip = floor( q );
	let fp = fract( q );
	var b = vec2f( 0.0 );
	for ( var y = -1; y <= 1; y++ ) { for ( var x = -1; x <= 1; x++ ) {
		let o = vec2f( f32( x ), f32( y ) );
		let cell = clMod2( ip + o, cells ) + seed;
		let hx = clHash2( cell ); let hy = clHash2( cell + 19.7 ); let hr = clHash2( cell + 41.3 ); let hp = clHash2( cell + 7.1 );
		let d = length( o + vec2f( hx, hy ) * 0.6 + 0.2 - fp );
		// radii 0.34 - 0.74 cells (was up to 0.9): neighbours in a row no longer fuse into one long ridge,
		// which from underneath read as a stretched, smeared tube
		let rad = hr * hr * 0.4 + 0.34;
		let on = smoothstep( hp - 0.15, hp + 0.15, meso + 0.12 );
		let v = sat( 1.0 - d / rad ) * on;
		if ( v > b.x ) { b = vec2f( v, hr ); }
	} }
	return b;
}
${ MAIN } {
	let p = ( vec2f( gid.xy ) + 0.5 ) / ${ f( WEATHER_RES ) };
	let meso = clVnoise2( p, vec2f( 4.0 ) ) * 0.6 + clVnoise2( p, vec2f( 8.0 ) ) * 0.3 + clVnoise2( p, vec2f( 16.0 ) ) * 0.1;
	// low frequency warp: irregular footprints, wavy streets
	let pw = p + ( vec2f( clVnoise2( p, vec2f( 24.0 ) ), clVnoise2( p + 0.37, vec2f( 24.0 ) ) ) - 0.5 ) * 0.03;
	// cloud streets along the wind (x), about 3 km apart
	let street = sin( pw.y * ${ f( 2 * PI * 11 ) } + clVnoise2( p, vec2f( 3.0 ) ) * 6.0 ) * 0.5 + 0.5;
	// fair weather cumulus: cells of 0.5 - 2 km, mostly along the streets
	// (loosely: a street seen end-on from under it lines its cells up into one long tube)
	let small = blobs( pw, vec2f( 15.0, 19.0 ), meso * 0.7 + street * 0.22 - 0.16, 0.0 );
	// big cells and towers (used far from the island only)
	let big = blobs( pw, vec2f( 6.0, 8.0 ), meso - 0.1, 3.7 );
	// turrets: several bumps per cell
	let lump = clVnoise2( pw, vec2f( 80.0 ) ) * 0.65 + clVnoise2( pw + 0.5, vec2f( 160.0 ) ) * 0.35;
	// top of the small cells (fraction of the layer): bigger cells grow taller
	let top = ( small.y * 0.35 + 0.4 ) * ( clVnoise2( p, vec2f( 12.0 ) ) * 0.5 + 0.75 );
	textureStore( outTex, gid.xy, vec4f( small.x, sat( top ), lump, big.x ) );
}` ),

			// ---- cirrus coverage: smooth fields of hundreds of km (u = x along the upper wind)
			syn: K( 'Cloud Synoptic Fields', [ noise ], { outTex: { storageTexture: this.synTex } }, /* wgsl */`${ MAIN } {
	let p = ( vec2f( gid.xy ) + 0.5 ) / ${ f( SYN_RES ) };
	let cov = clGfbm( p, vec2f( 2.0, 3.0 ), 0.31 );
	let streets = clGfbm( p, vec2f( 4.0, 14.0 ), 0.59 );
	let patches = clGfbm( p, vec2f( 10.0, 14.0 ), 0.83 ) * 0.7 + clGfbm( p, vec2f( 28.0, 40.0 ), 0.21 ) * 0.3;
	textureStore( outTex, gid.xy, clamp( vec4f( cov, streets, patches, 1.0 ), vec4f( 0.0 ), vec4f( 1.0 ) ) );
}` ),

			// ---- cirrus fibres: sparse seeds integrated along a smooth, gently meandering flow (line
			// integral convolution): long filaments of varied width, brightness and length
			aux: K( 'Cloud Fibre Flow', [ noise ], { outTex: { storageTexture: this.auxTex } }, /* wgsl */`
fn psi( q: vec2f ) -> f32 { return clGnoise2( q, vec2f( 3.0 ) ) * 0.5 + clGnoise2( q + 0.37, vec2f( 7.0 ) ) * 0.25 + clGnoise2( q + 0.71, vec2f( 15.0 ) ) * 0.1; }
// sparse jittered points: n cells per texture, probability, radius (cells), seed
fn points( p: vec2f, cluster: f32, n: f32, prob: f32, sigma: f32, seed: f32 ) -> f32 {
	let q = p * n;
	let ip = floor( q );
	let fp = fract( q );
	var v = 0.0;
	for ( var y = -1; y <= 1; y++ ) { for ( var x = -1; x <= 1; x++ ) {
		let o = vec2f( f32( x ), f32( y ) );
		let c = clMod2( ip + o, vec2f( n ) ) + seed;
		let pos = o + vec2f( clHash2( c ), clHash2( c + 19.7 ) ) * 0.8 + 0.1;
		let on = select( 0.0, 1.0, clHash2( c + 41.3 ) < cluster * prob );
		let d = pos - fp;
		v = max( v, exp( dot( d, d ) * ( -0.5 / ( sigma * sigma ) ) ) * on * ( clHash2( c + 7.1 ) * 0.7 + 0.3 ) );
	} }
	return v;
}
${ MAIN } {
	let p = ( vec2f( gid.xy ) + 0.5 ) / ${ f( FIB_RES ) };
	let e = ${ f( 1 / FIB_RES ) };
	let curl = vec2f( psi( p + vec2f( 0.0, e ) ) - psi( p - vec2f( 0.0, e ) ), psi( p - vec2f( e, 0.0 ) ) - psi( p + vec2f( e, 0.0 ) ) ) / ( 2.0 * e );
	let dir = normalize( vec2f( 1.0, 0.0 ) + vec2f( 0.0, clGnoise2( p + 0.13, vec2f( 3.0 ) ) * 0.5 ) + curl * 0.05 );
	let cluster = sat( clGfbm( p, vec2f( 5.0 ), 0.9 ) * 1.6 - 0.3 );
	let seeds = max( points( p, cluster, 110.0, 0.3, 0.18, 0.0 ), points( p, cluster, 44.0, 0.3, 0.18, 3.3 ) * 0.8 );
	// tufts (heads of hooked filaments) and, just downwind of them, a sideways sag of the flow
	let tuft = points( p, cluster, 40.0, 0.4, 0.1, 6.1 );
	let droop = points( p, cluster, 40.0, 0.4, 0.3, 6.1 );
	textureStore( outTex, gid.xy, vec4f( seeds, atan2( dir.y, dir.x ), tuft, droop ) );
}` ),

			// short strands: each wisp fades in and out along its length and is broken up by fine noise
			fib: K( 'Cloud Fibres', [ noise ], { auxTex: { texture: this.auxTex }, outTex: { storageTexture: this.fibTex } }, /* wgsl */`${ MAIN } {
	const LIC_STEPS = 44;
	let LIC_STEP = ${ f( 1 / FIB_RES ) };
	let p = ( vec2f( gid.xy ) + 0.5 ) / ${ f( FIB_RES ) };
	var x1 = p; var x2 = p;
	var fib = 0.0;
	var head = 0.0;
	for ( var i = 0; i < LIC_STEPS; i++ ) {
		let k = f32( i );
		let a = textureSampleLevel( auxTex, smpLinearRepeat, x1, 0.0 );
		fib += a.x * sin( ( k + 0.5 ) * ${ f( PI / 44 ) } );
		x1 -= vec2f( cos( a.y ), sin( a.y ) ) * LIC_STEP;
		// hooked tails: from the tuft downwind, sagging sideways
		let b = textureSampleLevel( auxTex, smpLinearRepeat, x2, 0.0 );
		head += b.z * exp( k * ${ f( - 1 / 12 ) } );
		x2 -= normalize( vec2f( cos( b.y ), sin( b.y ) + b.w * 1.2 ) ) * LIC_STEP;
	}
	let breakup = sat( clGfbm( p, vec2f( 24.0 ), 0.71 ) * 1.6 - 0.25 );
	let wisps = ( 1.0 - exp( fib * -0.8 ) ) * breakup;
	let hooks = 1.0 - exp( head * -0.5 );
	let veil = clGfbm( p, vec2f( 4.0 ), 0.33 );
	textureStore( outTex, gid.xy, vec4f( sat( max( wisps, hooks ) ), sat( veil ), 0.0, 1.0 ) );
}` ),
		};

		// ---- coverage dependent 3D distance field (Chebyshev, separable passes) of the dome footprint.
		// Built for a coverage a little above the current one, so small changes need no rebuild
		const sdfParams = this.params;
		const sdfMod = new ShaderModule( { name: 'cloudsSdfParams', deps: [ commonModule, helpers ], uniforms: sdfParams, uniformName: 'cloudsParams', code: '' } );
		// occupancy: a cell may hold cloud if the dome of any weather texel influencing it reaches
		// the cell's lowest altitude
		this.sdfOccKernel = K( 'Cloud SDF Occupancy', [ sdfMod ], { weatherTex: { texture: this.weatherTex }, outTex: { storageTexture: this.sdfA } }, /* wgsl */`${ MAIN } {
	let ix = i32( gid.x ); let iy = i32( gid.y );
	let h0 = f32( gid.z ) / ${ f( SDF_H ) };
	let thr = 1.0 - cloudsParams.sdfCoverage * 1.3;
	// conservative: maxima of every weather quantity around the cell (they are interpolated
	// separately), big cells assumed allowed
	var mx = vec4f( 0.0 );
	for ( var y = -1; y <= 2; y++ ) { for ( var x = -1; x <= 2; x++ ) {
		let wc = vec2i( ( ix * 2 + x + ${ WEATHER_RES } ) % ${ WEATHER_RES }, ( iy * 2 + y + ${ WEATHER_RES } ) % ${ WEATHER_RES } );
		mx = max( mx, textureLoad( weatherTex, wc, 0 ) );
	} }
	let cs = sat( ( mx.x - thr ) / max( 1.0 - thr, 0.05 ) );
	let cb = sat( ( mx.w - thr ) / max( 1.0 - thr, 0.05 ) );
	let occ = max( select( -1.0, clSmallTop( cs, mx.y, mx.z ), cs > 0.0 ), select( -1.0, clBigTop( cb, mx.z ), cb > 0.0 ) ) - h0;
	textureStore( outTex, gid, vec4f( select( 1.0, 0.0, occ > 0.0 ), 0.0, 0.0, 1.0 ) );
}` );

		this.sdfXKernel = K( 'Cloud SDF X', [ commonModule ], { src: { texture: this.sdfA }, outTex: { storageTexture: this.sdfB } }, /* wgsl */`${ MAIN } {
	let ix = i32( gid.x ); let iy = i32( gid.y ); let iz = i32( gid.z );
	var d = ${ f( SDF_R + 1 ) };
	for ( var k = ${ - SDF_R }; k <= ${ SDF_R }; k++ ) {
		if ( textureLoad( src, vec3i( ( ix + k + ${ SDF_RES } ) % ${ SDF_RES }, iy, iz ), 0 ).x * 255.0 < 0.5 ) {
			d = min( d, f32( abs( k ) ) );
		}
	}
	textureStore( outTex, gid, vec4f( d / 255.0, 0.0, 0.0, 1.0 ) );
}` );

		this.sdfYKernel = K( 'Cloud SDF Y', [ commonModule ], { src: { texture: this.sdfB }, outTex: { storageTexture: this.sdfA } }, /* wgsl */`${ MAIN } {
	let ix = i32( gid.x ); let iy = i32( gid.y ); let iz = i32( gid.z );
	var d = ${ f( SDF_R + 1 ) };
	for ( var k = ${ - SDF_R }; k <= ${ SDF_R }; k++ ) {
		d = min( d, max( textureLoad( src, vec3i( ix, ( iy + k + ${ SDF_RES } ) % ${ SDF_RES }, iz ), 0 ).x * 255.0, f32( abs( k ) ) ) );
	}
	textureStore( outTex, gid, vec4f( d / 255.0, 0.0, 0.0, 1.0 ) );
}` );

		this.sdfZKernel = K( 'Cloud SDF Z', [ commonModule ], { src: { texture: this.sdfA }, outTex: { storageTexture: this.sdfTex } }, /* wgsl */`${ MAIN } {
	let ix = i32( gid.x ); let iy = i32( gid.y ); let iz = i32( gid.z );
	var d = ${ f( SDF_R + 1 ) };
	for ( var k = ${ - ( SDF_H - 1 ) }; k <= ${ SDF_H - 1 }; k++ ) {
		let z = iz + k;
		if ( z >= 0 && z < ${ SDF_H } ) {
			d = min( d, max( textureLoad( src, vec3i( ix, iy, z ), 0 ).x * 255.0, f32( abs( k ) ) ) );
		}
	}
	textureStore( outTex, gid, vec4f( d / 255.0, 0.0, 0.0, 1.0 ) );
}` );

		// ---- view: one pixel of every 4x4 block per frame. Per trace: its own block + kernels (see header)
		this._traceSets = [];
		// created up front (at most REBUILD_SLOTS traces a frame) so their pipelines compile in the
		// background during loading, not serially in the first frame
		for ( let i = 0; i < REBUILD_SLOTS; i ++ ) this._traceSet( i );

		// ---- panorama (reflections / environment): interleaved progressive refresh (PANO_FULL: every texel)
		const panoCode = ( full ) => /* wgsl */`
// per pixel random offset (white noise: subsampled every 4 pixels, structured noise such as
// interleaved gradient noise would alias into a visible grid) for the golden ratio sequence
fn pixelHash( px: vec2f ) -> f32 {
	var p3 = fract( vec3f( px.x, px.y, px.x ) * vec3f( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
${ MAIN } {
	${ full ? 'let px = gid.xy;' : 'let px = gid.xy * vec2u( 8u, 4u ) + vec2u( cloudsParams.panoSlot );' }
	if ( px.x >= ${ PANO_W }u || px.y >= ${ PANO_H }u ) { return; }
	let uv = ( vec2f( px ) + 0.5 ) / vec2f( ${ f( PANO_W ) }, ${ f( PANO_H ) } );
	let az = uv.x * ${ f( 2 * PI ) };
	let elev = uv.y * uv.y * ${ f( ( 94 / 180 ) * PI ) } - ${ f( ( 4 / 180 ) * PI ) };
	let rd = vec3f( cos( elev ) * cos( az ), sin( elev ), cos( elev ) * sin( az ) );
	let jitter = pixelHash( vec2f( px ) );
	let m = cloudsMarchPano( rd, jitter );
	// panorama texel: 2 pi / PANO_W across; the elevation mapping is similar near the horizon
	let hi = cloudsHigh( rd, ${ f( 2 * PI / PANO_W ) } );
	textureStore( outTex, px, clOver( vec4f( m.L, m.T ), hi ) );
}`;
		this.panoKernel = K( 'Clouds Panorama', [ this.coreModule ], { outTex: { storageTexture: this.panorama } }, panoCode( false ) );
		this.panoFullKernel = K( 'Clouds Panorama (full)', [ this.coreModule ], { outTex: { storageTexture: this.panorama } }, panoCode( true ) );

		// ---- cloud shadow: transmittance of the layer along the key light (sun, or the moon at
		// night), 1/4 of the rows per frame
		this.shadowKernel = K( 'Cloud Shadow', [ this.coreModule ], { outTex: { storageTexture: this.shadowMap } }, /* wgsl */`${ MAIN } {
	let px = vec2u( gid.x, gid.y * 4u + u32( cloudsParams.shadowPhase ) );
	let uv = ( vec2f( px ) + 0.5 ) / ${ f( SHADOW_RES ) };
	// camera relative ground position
	let gxz = cloudsParams.shadowCenter + ( uv - 0.5 ) * cloudsParams.shadowSize - cloudsParams.camXZ;
	let sunDir = frame.sunDir;
	let mu = max( sunDir.y, 0.08 );
	let tb = cloudsParams.bottom / mu;
	let tt = cloudsParams.top / mu;
	var od = 0.0;
	const steps = 8;
	for ( var k = 0; k < steps; k++ ) {
		let t = mix( tb, tt, ( f32( k ) + 0.5 ) / f32( steps ) );
		let p = cloudsSheared( vec3f( gxz.x, 0.0, gxz.y ) + sunDir * t );
		od += clMeanDensity( cloudsBase( p, cloudsWeather( p.xz ) ) );
	}
	let T = exp( od * cloudsParams.densityScale * ( ( tt - tb ) / f32( steps ) ) * -0.5 );
	textureStore( outTex, px, vec4f( T, 0.0, 0.0, 1.0 ) );
}` );

	}

	// the kernels of the i-th trace of a frame (own uniform block: slot, previous camera, ...)
	_traceSet( i ) {

		if ( this._traceSets[ i ] ) return this._traceSets[ i ];
		const block = new UniformBlock( 'CloudsTrace', {
			slot: [ 'vec2f', new Vector2() ],
			subPixel: [ 'vec2f', new Vector2() ],
			prevRight: [ 'vec3f', new Vector3() ],
			frameNoise: [ 'f32', 0 ],
			prevUp: [ 'vec3f', new Vector3() ],
			rebuildK: [ 'f32', - 1 ],
			prevFwd: [ 'vec3f', new Vector3() ],
			minAlpha: [ 'f32', 0.12 ],
			prevTan: [ 'vec2f', new Vector2( 1, 1 ) ],
			historyValid: [ 'f32', 0 ],
			pad: [ 'f32', 0 ],
			camDelta: [ 'vec3f', new Vector3() ],
			camDeltaHi: [ 'vec3f', new Vector3() ],
		}, { label: 'cloudsTrace' + i } );
		const traceMod = new ShaderModule( {
			name: 'cloudsTrace' + i,
			deps: [ this.coreModule ],
			uniforms: block,
			uniformName: 'cloudsTrace',
			code: /* wgsl */`
fn cloudsViewDir( uv: vec2f ) -> vec3f {
	let ndc = vec2f( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0 ) * cloudsParams.camTan;
	return normalize( cloudsParams.camFwd + cloudsParams.camRight * ndc.x + cloudsParams.camUp * ndc.y );
}
// interleaved gradient noise (Jimenez 2014)
fn cloudsIGN( px: vec2f ) -> f32 { return fract( fract( dot( px, vec2f( 0.06711056, 0.00583715 ) ) ) * 52.9829189 ); }
fn cloudsTracedPixel( tp: vec2u ) -> vec2f { return vec2f( tp * 4u + vec2u( cloudsTrace.slot ) ) + 0.5 + cloudsTrace.subPixel; }
fn cloudsOutside( tp: vec2u ) -> bool { return tp.x >= u32( cloudsParams.traceSize.x ) || tp.y >= u32( cloudsParams.traceSize.y ); }
`,
		} );
		const K = ( label, bindings, code ) => new ComputeKernel( { label, modules: [ traceMod ], bindings, code, workgroupSize: [ 8, 8, 1 ] } );
		const MAIN = '@compute @workgroup_size( WG_X, WG_Y, WG_Z ) fn main( @builtin( global_invocation_id ) gid: vec3u )';

		const trace = K( 'Clouds Trace', { traceOut: { storageTexture: this.traceTex }, depthOut: { storageTexture: this.traceDepth } }, /* wgsl */`${ MAIN } {
	let tp = gid.xy;
	if ( cloudsOutside( tp ) ) { return; }
	let px = cloudsTracedPixel( tp );
	let rd = cloudsViewDir( px / cloudsParams.viewSize );
	// well distributed in space (interleaved gradient noise on the grid of traced pixels) and over
	// the traces of each pixel (per cycle offset): the residual noise is high frequency, easy to average
	let jitter = fract( cloudsIGN( vec2f( tp ) ) + cloudsTrace.frameNoise );
	let m = cloudsMarchView( rd, jitter );
	textureStore( traceOut, tp, vec4f( m.L, m.T ) );
	// depth + opacity of the cumulus: the resolve reprojects either the cumulus or the high layers
	textureStore( depthOut, tp, vec4f( m.depth, 1.0 - m.T, 0.0, 1.0 ) );
}` );

		// high layers for the same pixels (separate kernel: keeps the march kernel lean)
		const high = K( 'Clouds High Trace', { traceDepth: { texture: this.traceDepth }, highOut: { storageTexture: this.highTrace }, motionOut: { storageTexture: this.motionTex } }, /* wgsl */`${ MAIN } {
	let tp = gid.xy;
	if ( cloudsOutside( tp ) ) { return; }
	let px = cloudsTracedPixel( tp );
	let rd = cloudsViewDir( px / cloudsParams.viewSize );
	var hi = vec4f( 0.0, 0.0, 0.0, 1.0 );
	if ( rd.y > -0.01 ) {
		hi = cloudsHigh( rd, cloudsParams.camTan.y * 2.0 / cloudsParams.viewSize.y );
	}
	textureStore( highOut, tp, hi );

	// motion for the resolve: the closest cumulus sample around this block (like the closest
	// depth dilation of TAA), so the edges of a cloud move with it and foreground wins
	var best = vec3f( 1e9, 0.0, 0.0 ); // depth key, depth, opacity
	let tmax = vec2i( cloudsParams.traceSize ) - 1;
