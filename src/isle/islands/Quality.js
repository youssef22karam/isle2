// Quality — performance profiles for this build (my code, not the game's).
//
// The tidewater modules are never edited; every saving here comes from the
// values this build passes INTO them (constructor options) and from the
// engine's render scale. Three tiers:
//
//   high     — the heaviest configuration (shadow map 2048, shore sim res
//              768, terrain grid 40, ocean grid 32 × 12 levels, spray 32768
//              GPU + 8192 CPU particles, foam texture 1024, caustics on,
//              render scale up to 1.5×). Opt-in only, never the default.
//   balanced — render scale capped at 1.25×, shadow map 1024, shore sim
//              res 512, terrain grid 32, spray halved. Same sea, same
//              features, roughly half the pixels and sim texels.
//   light    — render scale 1.0× (CSS resolution — the game's own engine
//              default), sun shadows OFF (the game's own Performance-tab
//              toggle) with a 512 map allocated, shore sim res 384,
//              terrain grid 24, ocean grid 24 × 11 levels, spray quartered,
//              foam texture 512, caustics off (the game's own ?noCaustics
//              configuration).
//
// `scaleCap`, `shadows` (enabled) apply LIVE via engine.setRenderScale()
// and shadows.enabled. Everything else is baked into GPU resources at
// construction time, so switching to a tier that differs in those fields
// persists the choice and reloads the page (see needsRebuild).
//
// The wave math is identical in every tier: the OceanFFT is constructed
// with its defaults (256², 4 cascades) in all of them — FFT_SIZE is a
// module-level constant in OceanFFT.js with no configuration surface, and
// dropping a cascade would remove a band of the sea itself.

export const QUALITY_PROFILES = {
	high: { scaleCap: 1.5, shadowSize: 2048, shadows: true, shoreRes: 768, terrainGrid: 40, oceanGrid: 32, oceanLevels: 12, sprayGPU: 32768, sprayCPU: 8192, foamSize: 1024, caustics: true },
	balanced: { scaleCap: 1.0, shadowSize: 1024, shadows: true, shoreRes: 640, terrainGrid: 32, oceanGrid: 32, oceanLevels: 12, sprayGPU: 16384, sprayCPU: 4096, foamSize: 1024, caustics: true },
	light: { scaleCap: 1.0, shadowSize: 512, shadows: false, shoreRes: 512, terrainGrid: 24, oceanGrid: 24, oceanLevels: 11, sprayGPU: 8192, sprayCPU: 2048, foamSize: 512, caustics: false },
};

// fields baked into GPU resources at construction time (a change reloads)
const REBUILD_KEYS = [ 'shadowSize', 'shoreRes', 'terrainGrid', 'oceanGrid', 'oceanLevels', 'sprayGPU', 'sprayCPU', 'foamSize', 'caustics' ];

export function needsRebuild( a, b ) {

	return REBUILD_KEYS.some( ( k ) => a[ k ] !== b[ k ] );

}

// canvas pixels per CSS pixel for a profile on this device
export function effectiveRenderScale( profile ) {

	return Math.min( window.devicePixelRatio || 1, profile.scaleCap );

}

const STORAGE_KEY = 'tidewater-islands-quality';

// Default tier when the user has never chosen: phones / touch devices get
// Light (large touch screens Balanced), desktops get Balanced. No default
// ever renders above 1x CSS resolution (the first tidewater build's 1.75x
// default was the main reason it was heavy on the user's phone); High is
// strictly opt-in from the HUD.
export function autoQuality() {

	try {

		const coarse = !! ( window.matchMedia && window.matchMedia( '(pointer: coarse)' ).matches );
		if ( coarse ) {

			// phones have a short side of ~450 CSS px or less; tablets ~770+
			const small = Math.min( window.innerWidth, window.innerHeight ) <= 600;
			return small ? 'light' : 'balanced';

		}

	} catch ( e ) { /* fall through to balanced */ }
	return 'balanced';

}

// Resolution order: ?q= / #q= in the URL, then the saved choice, then auto.
export function resolveQuality() {

	try {

		const fromSearch = new URLSearchParams( window.location.search ).get( 'q' );
		if ( fromSearch && QUALITY_PROFILES[ fromSearch ] ) return fromSearch;
		const fromHash = new URLSearchParams( String( window.location.hash ).replace( /^#/, '' ) ).get( 'q' );
		if ( fromHash && QUALITY_PROFILES[ fromHash ] ) return fromHash;

	} catch ( e ) { /* ignore */ }
	try {

		const saved = window.localStorage.getItem( STORAGE_KEY );
		if ( saved && QUALITY_PROFILES[ saved ] ) return saved;

	} catch ( e ) { /* ignore */ }
	return autoQuality();

}

export function saveQuality( name ) {

	try { window.localStorage.setItem( STORAGE_KEY, name ); } catch ( e ) { /* ignore */ }
	try {

		const url = new URL( window.location.href );
		url.hash = 'q=' + name;
		window.history.replaceState( null, '', url );

	} catch ( e ) { /* ignore */ }

}
