// EnvControls.js — sun / time / clouds / weather controls (my glue).
//
// The values, ranges and push-semantics are tidewater's own, copied from
// the game's panel (src/ui/AppUI.js): the SEA preset table, the slider
// definitions, and the spectrum() / whitecaps() / clarity() functions that
// push panel values into the simulation. AppUI.js itself is not imported
// (it drives the game's full tabbed UI framework, which this build does
// not carry); this module is the same binding layer, written against the
// same live objects the game reads:
//
//   fft.local.windSpeed / windDirection / fetch, fft.swell.scale,
//   fft.choppiness.value, fft.foamBias / foamDecay (derived),
//   fft.updateSpectrumUniforms(), G.windDir / G.windSpeed,
//   G.waterAbsorption / G.waterScattering (derived from clarity),
//   shore.amplitude / period / gamma / curl (.value),
//   breakers.params.spray / sheet (.value), caustics.strength.value,
//   clouds.coverage / cirrus (.value),
//   settings.timeOfDay / sunAzimuth / timeSpeed.
//
// The state object holds plain numbers (exactly like AppUI's `s`); every
// write goes through setValue()/applyPreset(), which push into the live
// systems immediately — there is no second copy of the simulation state.

// ---------------------------------------------------------------- presets
// VERBATIM from tidewater's ui/AppUI.js (the SEA table).
export const SEA_PRESETS = {
	Calm: { wind: 3.5, fetch: 40, chop: 0.75, swell: 0.28, surf: 0.18, period: 11, whitecaps: 0.2 },
	Breezy: { wind: 7, fetch: 120, chop: 0.9, swell: 0.48, surf: 0.34, period: 9, whitecaps: 0.5 },
	Choppy: { wind: 12, fetch: 300, chop: 1.05, swell: 0.68, surf: 0.56, period: 8.5, whitecaps: 0.75 },
	Storm: { wind: 20, fetch: 900, chop: 1.2, swell: 1.0, surf: 0.9, period: 12, whitecaps: 1 },
};
export const SEA_PRESET_ORDER = [ 'Calm', 'Breezy', 'Choppy', 'Storm' ];

// ------------------------------------------------------- slider definitions
// Names, ranges, steps and units VERBATIM from tidewater's ui/AppUI.js
// (Sea state / Water / Surf folders and the Sky tab's Sun / Atmosphere
// folders). `fmt` names a display formatter implemented by the HUD:
//   'time'    -> HH:MM          'percent' -> Math.round(v*100) + '%'
//   'waveHeight' -> (v*2).toFixed(2) + ' m'   (AppUI's own format for surf)
// `log: true` = AppUI's logarithmic slider mapping (Fetch).
export const ENV_SLIDERS = [
	// Sun (AppUI's Sky tab)
	{ key: 'time', group: 'sun', label: 'Time of day', min: 0, max: 24, step: 0.05, fmt: 'time' },
	{ key: 'azimuth', group: 'sun', label: 'Sun azimuth', min: - 180, max: 180, step: 1, unit: '°' },
	// Atmosphere (AppUI's Sky tab)
	{ key: 'clouds', group: 'clouds', label: 'Cloud cover', min: 0, max: 1, step: 0.01, fmt: 'percent' },
	{ key: 'cirrus', group: 'clouds', label: 'Cirrus', min: 0, max: 1, step: 0.01, fmt: 'percent' },
	// Sea state (AppUI's Ocean tab)
	{ key: 'wind', group: 'weather', label: 'Wind speed', min: 0.5, max: 30, step: 0.1, unit: 'm/s' },
	{ key: 'windDir', group: 'weather', label: 'Wind direction', min: 0, max: 360, step: 1, unit: '°' },
	{ key: 'fetch', group: 'weather', label: 'Fetch', min: 5, max: 2000, step: 1, unit: 'km', log: true },
	{ key: 'chop', group: 'weather', label: 'Choppiness', min: 0, max: 1.6, step: 0.01 },
	{ key: 'swell', group: 'weather', label: 'Ocean swell', min: 0, max: 2, step: 0.01 },
	{ key: 'whitecaps', group: 'weather', label: 'Whitecaps', min: 0, max: 1, step: 0.01 },
	{ key: 'clarity', group: 'weather', label: 'Clarity', min: 0.3, max: 2, step: 0.01 },
	// Surf (AppUI's Shore tab)
	{ key: 'surf', group: 'weather', label: 'Wave height', min: 0, max: 1.4, step: 0.01, unit: 'm', fmt: 'waveHeight' },
	{ key: 'period', group: 'weather', label: 'Wave period', min: 5, max: 16, step: 0.1, unit: 's' },
	{ key: 'gamma', group: 'weather', label: 'Breaking depth ratio', min: 0.5, max: 1.1, step: 0.01 },
	{ key: 'curl', group: 'weather', label: 'Curl', min: 0, max: 1.5, step: 0.01 },
	{ key: 'spray', group: 'weather', label: 'Spray', min: 0, max: 2, step: 0.01 },
	{ key: 'lip', group: 'weather', label: 'Lip sheet', min: 0, max: 1.5, step: 0.01 },
	{ key: 'caustics', group: 'weather', label: 'Caustics intensity', min: 0, max: 2, step: 0.01 },
];

// keys whose manual adjustment marks the weather as custom (preset off)
export const WEATHER_KEYS = [ 'wind', 'windDir', 'fetch', 'chop', 'swell', 'whitecaps', 'clarity', 'surf', 'period', 'gamma', 'curl', 'spray', 'lip', 'caustics' ];

// ------------------------------------------------------------- time speed
// Stepped cycle rates. tidewater's own panel exposes timeSpeed as a log
// slider over 0.002..1 hours per real second (its T-key toggle defaults
// to 0.05 h/s = a full day in 8 minutes); these steps sit inside that
// range and are labelled by the day length they produce.
export const TIME_SPEED_STEPS = [
	{ value: 0.01, label: '40 min/day' },
	{ value: 0.05, label: '8 min/day' },
	{ value: 0.25, label: '96 s/day' },
	{ value: 1, label: '24 s/day' },
];
export const DEFAULT_TIME_SPEED = 0.01; // a full day in 40 minutes

export function formatTimeOfDay( h ) {

	const t = ( ( h % 24 ) + 24 ) % 24;
	const hh = Math.floor( t );
	const mm = Math.floor( ( t - hh ) * 60 );
	return String( hh ).padStart( 2, '0' ) + ':' + String( mm ).padStart( 2, '0' );

}

// ---------------------------------------------------------------- controls
// deps: { settings, fft, shore, breakers, caustics, clouds, globals, math }
// — the LIVE system objects (the same references the app itself holds, so
// a write here is a write the simulation reads). `globals` is the game's
// G (core/Globals.js); `math` is the engine's MathUtils.
export function createEnvControls( deps ) {

	const { settings, fft, shore, breakers, caustics, clouds, globals: G, math } = deps;

	// ---- plain values the controls bind to; onChange pushes them into
	// the simulation (initialised from the live systems, as AppUI does)
	const state = {
		wind: fft.local.windSpeed,
		windDir: fft.local.windDirection,
		fetch: fft.local.fetch,
		chop: fft.choppiness.value,
		swell: fft.swell.scale,
		whitecaps: 0.5,
		clarity: 1,
		surf: shore.amplitude.value,
		period: shore.period.value,
		gamma: shore.gamma.value,
		curl: shore.curl.value,
		spray: breakers ? breakers.params.spray.value : 0,
		lip: breakers ? breakers.params.sheet.value : 0,
		caustics: caustics ? caustics.strength.value : 1,
		time: settings.timeOfDay,
		azimuth: settings.sunAzimuth || 0,
		clouds: clouds ? clouds.coverage.value : 0.45,
		cirrus: clouds && clouds.cirrus ? clouds.cirrus.value : 0.5,
		preset: 'Breezy', // the OceanFFT is constructed with the game's Breezy spectrum
		advance: true, // the day/night cycle runs from load
		timeSpeed: DEFAULT_TIME_SPEED,
	};
	settings.timeSpeed = state.timeSpeed; // cycle running (see setAdvance)

	// ---- the game's own push functions (ui/AppUI.js, verbatim semantics)
	const spectrum = () => {

		fft.local.windSpeed = state.wind;
		fft.local.windDirection = state.windDir;
		fft.local.fetch = state.fetch;
		fft.swell.scale = state.swell;
		fft.updateSpectrumUniforms();
		const a = math.degToRad( state.windDir );
		G.windDir.value.set( Math.cos( a ), Math.sin( a ) );
		G.windSpeed.value = state.wind;

	};

	const whitecapsPush = () => {

		fft.foamBias.value = 0.5 + 0.16 * state.whitecaps + 0.01 * math.clamp( state.wind - 7, - 5, 12 );
		fft.foamDecay.value = 0.6 - 0.35 * state.whitecaps;

	};

	const clarityPush = () => {

		// scale absorption/scattering around the tropical defaults
		const k = 1 / Math.max( 0.2, state.clarity );
		G.waterAbsorption.value.set( 0.42, 0.075, 0.035 ).multiplyScalar( 0.6 + 0.4 * k );
		G.waterScattering.value.set( 0.012, 0.018, 0.024 ).multiplyScalar( k * k );

	};

	const controls = {

		state,
		systems: deps, // the live objects, for identity checks

		// one slider moved: write the value and push it exactly where
		// AppUI's onChange for that slider pushes it
		setValue( key, v ) {

			switch ( key ) {

				case 'wind': state.wind = v; spectrum(); whitecapsPush(); break;
				case 'windDir': state.windDir = v; spectrum(); break;
				case 'fetch': state.fetch = v; spectrum(); break;
				case 'chop': state.chop = v; fft.choppiness.value = v; break;
				case 'swell': state.swell = v; spectrum(); break;
				case 'whitecaps': state.whitecaps = v; whitecapsPush(); break;
				case 'clarity': state.clarity = v; clarityPush(); break;
				case 'surf': state.surf = v; shore.amplitude.value = v; break;
				case 'period': state.period = v; shore.period.value = v; break;
				case 'gamma': state.gamma = v; shore.gamma.value = v; break;
				case 'curl': state.curl = v; shore.curl.value = v; break;
				case 'spray': state.spray = v; if ( breakers ) breakers.params.spray.value = v; break;
				case 'lip': state.lip = v; if ( breakers ) breakers.params.sheet.value = v; break;
				case 'caustics': state.caustics = v; if ( caustics ) caustics.strength.value = v; break;
				case 'clouds': state.clouds = v; if ( clouds ) clouds.coverage.value = v; break;
				case 'cirrus': state.cirrus = v; if ( clouds && clouds.cirrus ) clouds.cirrus.value = v; break;
				case 'time': state.time = v; settings.timeOfDay = v; break;
				case 'azimuth': state.azimuth = v; settings.sunAzimuth = v; break;
				default: return;

			}
			if ( WEATHER_KEYS.includes( key ) ) state.preset = null; // manual = custom

		},

		// a sea-state preset: AppUI's apply(), verbatim
		applyPreset( name ) {

			const p = SEA_PRESETS[ name ];
			if ( ! p ) return;
			Object.assign( state, p );
			spectrum();
			whitecapsPush();
			fft.choppiness.value = state.chop;
			shore.amplitude.value = state.surf;
			shore.period.value = state.period;
			state.preset = name;

		},

		// the cycle play/pause (AppUI's "Advance time" toggle)
		setAdvance( on ) {

			state.advance = !! on;
			settings.timeSpeed = state.advance ? state.timeSpeed : 0;

		},

		setSpeed( v ) {

			state.timeSpeed = v;
			if ( state.advance ) settings.timeSpeed = v;

		},

		// per-frame: the game's own advance (App._frame), wrapped at 24
		advanceTime( dt ) {

			if ( settings.timeSpeed !== 0 ) {

				settings.timeOfDay = ( settings.timeOfDay + dt * settings.timeSpeed + 24 ) % 24;
				state.time = settings.timeOfDay;

			}
			return settings.timeOfDay;

		},

	};

	return controls;

}
