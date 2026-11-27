		// around the bare rock: dark humus, stones and moss, with the surrounding plants creeping
		// in (a soft, noisy band; no speckle)
		let creepIn = smoothstep( 0.4, 0.75, dM.w + ( dN.y - 0.45 ) * 0.5 + ( macroB - 0.5 ) * 0.3 );
		var scree = mix( ${ S( 0.16, 0.13, 0.1 ) }, ${ S( 0.27, 0.24, 0.2 ) }, smoothstep( 0.45, 0.75, dM.x + ( dN.x - 0.5 ) * 0.3 ) );
		scree = mix( scree, mix( ${ S( 0.13, 0.18, 0.06 ) }, ${ S( 0.22, 0.26, 0.09 ) }, dF.y ), smoothstep( 0.45, 0.7, dM.y + ( dN.y - 0.45 ) * 0.5 ) * 0.7 );
		ground = mix( ground, scree, screeW * ( 1.0 - creepIn * 0.7 ) );
		let laterite = mix( ${ S( 0.42, 0.25, 0.16 ) }, ${ S( 0.52, 0.36, 0.24 ) }, dM.w ) * ( ( dN.y - 0.4 ) * 0.3 + 1.0 );
		ground = mix( ground, laterite, lateriteW );

		// ---- worn dirt paths / trampled ground (darker, redder soil in the forest)
		var dirt = mix( ${ S( 0.38, 0.31, 0.23 ) }, ${ S( 0.5, 0.43, 0.32 ) }, dM.w ) * ( ( dN.y - 0.4 ) * 0.35 + 0.95 );
		dirt = mix( dirt, ${ S( 0.3, 0.22, 0.15 ) }, jungleW * 0.7 );
		dirt = mix( dirt, ${ S( 0.56, 0.53, 0.48 ) }, smoothstep( 0.72, 0.82, dN.z ) * 0.5 );
		// grass creeping onto the trail, a grassy strip between the two worn ruts
		let creep = smoothstep( 0.45, 0.7, dN.y + ( dF.y - 0.45 ) * 0.5 ) * smoothstep( 0.9, 0.5, sp.y );
		dirt = mix( dirt, lawn, creep * 0.8 );

		// ---- combine
		let meadowW = ( 1.0 - jungleW ) * ( 1.0 - pathW ) * notRock * ( 1.0 - sandW ) * landW * ( 1.0 - screeW );
		terMeadowW = meadowW;
		var albedo = mix( ground, dirt, pathW );
		albedo = mix( albedo, sand, max( sandW, underW * notRock ) );
		albedo = mix( albedo, rockAlbedo, rockW );

		// ---- eroded beach scarp (splat alpha on land): storm-cut face of the foredune. Layered
		// sandy soil (laminae of paler and darker sand, darker humus-stained patches), live roots
		// and pale dead-root tangles hanging out of the face, damp darker sand at the toe.
		let scarpW = sat( sp.w * 1.6 ) * landW * notRock;
		var scarpH = 0.0;
		if ( scarpW > 0.003 ) {

			// laminae: thin storm layers, warped and wedging out, with a set of cross-beds at a low angle
			let tanF = normalize( vec2f( -N0.z, N0.x ) + vec2f( 1e-4, 0.0 ) );
			let alongF = dot( xz, tanF );
			let hw = h + ( dM.w - 0.5 ) * 0.5 + ( dN.w - 0.5 ) * 0.12 + ( macroB - 0.5 ) * 0.35;
			let lam = sin( hw * ( 6.2832 / 0.11 ) + dN.x * 2.0 ) * 0.5 + 0.5;
			let cross = sin( ( hw + alongF * 0.09 ) * ( 6.2832 / 0.075 ) ) * 0.5 + 0.5;
			let lamB = smoothstep( 0.3, 0.7, sin( ( hw + dM.y * 0.4 ) * ( 6.2832 / 0.43 ) ) * 0.5 + 0.5 );
			let layerMix = mix( lam, cross, smoothstep( 0.4, 0.6, dM.x ) );
			var soil = mix( ${ S( 0.5, 0.42, 0.31 ) }, ${ S( 0.68, 0.6, 0.46 ) }, smoothstep( 0.3, 0.8, layerMix ) * 0.45 + lamB * 0.2 + ( grain - 0.45 ) * 0.5 + ( dM.w - 0.5 ) * 0.3 );
			// humus-stained, rootier soil in patches (the old dune surface caught in the cut)
			soil = mix( soil, ${ S( 0.26, 0.2, 0.14 ) }, smoothstep( 0.55, 0.8, dM.y + ( macroB - 0.5 ) * 0.5 ) * 0.55 );
			// roots: horizontal coordinate along the face, stretched down the fall line
			let ru = terDetail( vec2f( dot( xz, tanF ) / 0.8, h / 0.5 ) + vec2f( 0.37, 0.11 ) );
			let rv = terDetail( vec2f( dot( xz, tanF ) / 1.7 + h * 0.6, h / 0.9 ) + vec2f( 0.71, 0.29 ) );
			let rootLive = smoothstep( 0.035, 0.0, abs( ru.x - 0.5 ) ) * smoothstep( 0.45, 0.62, ru.w );
			let rootDead = smoothstep( 0.03, 0.0, abs( rv.z - 0.52 ) ) * smoothstep( 0.5, 0.66, rv.y );
			soil = mix( soil, ${ S( 0.17, 0.12, 0.08 ) }, rootLive * 0.85 );
			soil = mix( soil, ${ S( 0.8, 0.75, 0.66 ) }, rootDead * 0.75 );
			// damp, darker sand toward the toe and in seepage streaks
			let seep = smoothstep( 0.6, 0.8, terDetail( vec2f( dot( xz, tanF ) / 2.3, h / 6.0 ) ).w ) * 0.35;
			soil = soil * ( 1.0 - seep - smoothstep( 0.5, 1.0, sp.w ) * 0.08 );
			// under the lip: the dark, rooty topsoil the grass grows in, overhanging the cut
			let lip = smoothstep( 0.86, 0.97, sp.w + ( dN.y - 0.45 ) * 0.1 );
			soil = mix( soil, ${ S( 0.2, 0.15, 0.1 ) } * ( dN.x * 0.4 + 0.8 ), lip * 0.85 );
			// foot of the face: undercut by the swash of storm waves, in its own shadow
			soil *= 1.0 - ( 1.0 - smoothstep( 0.6, 0.78, sp.w ) ) * smoothstep( 0.35, 0.55, sp.w ) * 0.25;
			// slumped sand and fallen chunks at the toe: damp beach sand rather than soil
			soil = mix( ${ S( 0.63, 0.56, 0.44 ) } * ( grain * 0.3 + 0.85 ), soil, smoothstep( 0.35, 0.75, sp.w ) );
			albedo = mix( albedo, soil, scarpW );
			scarpH = ( lip * 0.03 + layerMix * 0.012 + lamB * 0.018 + rootLive * 0.012 + rootDead * 0.009 + dN.x * 0.025 );

		}

		// ---- wetness (swash zone) from the shore system, else a static damp band
		let wetFoam = terWetFoam( xz, h );
		let wet = sat( wetFoam.x ) * ( 1.0 - jungleW * 0.8 ) * landW;
		// damp sand below the berm: darker in mottled, drying patches even when the swash has not
		// reached it lately
		let dampMottle = smoothstep( 0.3, 0.7, dM.w + ( dN.y - 0.45 ) * 0.6 + ( macroB - 0.5 ) * 0.4 );
		let damp = smoothstep( 1.7, 0.5, h + dM.w * 0.3 ) * sandW * mix( 0.22, 0.5, dampMottle );
		// sand dries in mottled patches; backwash leaves faint rills down the slope
		let mottle = smoothstep( 0.25, 0.75, dM.w + ( dN.y - 0.45 ) * 0.5 );
		let dryEdge = smoothstep( 0.0, 0.6, wet ) * smoothstep( 1.0, 0.6, wet );
		let wetK = max( wet, damp ) * ( 1.0 - dryEdge * mottle * 0.6 ) * notRock;
		let slopeDir = normalize( N0.xz + vec2f( 1e-4, 0.0 ) );
		let rillK = smoothstep( 0.2, 0.9, wet ) * smoothstep( 0.05, 0.6, h ) * sandW;
		var rill = 0.5;
		if ( rillK > 0.0 ) { rill = terDetail( vec2f( dot( xz, slopeDir ) / 3.2, dot( xz, vec2f( -slopeDir.y, slopeDir.x ) ) / 0.3 ) ).w; }
		let wetAlbedo = terrainSaturation( albedo * mat.wetDarken, 1.15 ) * vec3f( 0.97, 0.98, 1.0 ) * ( ( rill - 0.5 ) * 0.25 * rillK + 1.0 );
		albedo = mix( albedo, wetAlbedo, wetK );
		// swash marks: thin wavy lines of grit left at the limits of earlier uprushes
		let sl = ( h + dM.w * 0.18 + dN.w * 0.05 ) / 0.13;
		let slD = abs( fract( sl ) - 0.5 );
		let slW = fwidth( sl ) + 1e-4;
		let swashLine = smoothstep( slW * 1.5 + 0.04, 0.0, slD ) * smoothstep( 0.2, 0.4, h ) * smoothstep( 1.6, 1.2, h )
			* smoothstep( 0.45, 0.65, dM.y + ( macroB - 0.5 ) * 0.4 ) * sandW * ( 1.0 - smoothstep( 0.8, 2.0, slW * 10.0 ) );
		albedo = mix( albedo * ( 1.0 - swashLine * 0.3 ), ${ S( 0.9, 0.88, 0.84 ) }, swashLine * smoothstep( 0.6, 0.75, dF.z ) * 0.5 );
		// foam residue: lacy patterns stranded on the sand
		var residue = sat( wetFoam.y ) * landW * notRock;
		if ( residue > 0.0 ) { residue *= smoothstep( 0.42, 0.18, terDetail( ${ rot2( 'xz', 0.4 ) } / 0.9 ).x ) * 0.7 + 0.3; }
		albedo = mix( albedo, ${ S( 0.88, 0.9, 0.9 ) }, residue );

		// ---- roughness
		var rough = mix( 0.88, 0.93, sandW );
		rough = mix( rough, 0.9, pathW );
		rough = mix( rough, rockRough, rockW );
		// wet sand has a film of water: glossy while fresh, satin as it drains
		rough = mix( rough, mix( 0.42, 0.16, wet ), wetK );
		rough = mix( rough, 0.7, residue );
		rough = mix( rough, 0.75, underW );
		rough = mix( rough, 0.94, scarpW );
		outRough = rough;

		// ---- micro relief for the normal
		let windR = rip1 * 0.005 * windK;
		let waveR = rip3 * 0.012 * fade3 * smoothstep( -0.3, -0.9, h ) * ( 1.0 - seagrassW );
		let megaR = rip2 * 0.035 * fade2 * fieldW * ( 1.0 - seagrassW );
		let sandH = ( grain * 0.004 + grainF * 0.003 + pebW * 0.004 + windR + waveR + megaR ) * ( 1.0 - wet * 0.6 )
			+ rill * 0.006 * rillK;
		// seagrass canopy stands proud of the sand with a ragged scarp; rubble is knobbly
		let seabedH = seagrassW * ( blades * 0.05 + 0.08 ) + rubbleW * ( dN.x * 0.07 + dF.x * 0.015 );
		let groundH = dN.y * mix( 0.05, 0.035, jungleW ) + dF.y * 0.012 + dM.y * 0.045 + canopyH * canopyW * 2.5
			+ clump * 0.12 * ( 1.0 - jungleW ) + comb * 0.03 * ( 1.0 - jungleW );
		let screeH = dN.z * 0.04 + dM.x * 0.06;
		let dirtH = dN.z * 0.012 + dN.y * 0.01;
		var hd = mix( mix( groundH, screeH, screeW ), dirtH, pathW );
		hd = mix( hd, sandH + seabedH, max( sandW, underW * notRock ) );
		hd = mix( hd, rockHd, rockW );
		hd = mix( hd, scarpH, scarpW );
		hdOut = hd;

		// ---- ambient occlusion: baked horizon + cavity, plus litter / crevices / seagrass canopy
		let aoDetail = mix( 1.0, dN.y * 0.5 + 0.7, jungleW * ( 1.0 - sandW ) * notRock * landW )
			* mix( 1.0, smoothstep( 0.2, 0.7, clump ) * 0.35 + 0.65, meadowW );
		outAO = nr.w * aoDetail * ( 1.0 - seagrassW * 0.3 ) * ( 1.0 - rubbleW * smoothstep( 0.55, 0.2, dN.x ) * 0.35 )
			* mix( 1.0, smoothstep( 0.15, 0.6, canopyH ) * 0.6 + 0.4, canopyW );

		albedoOut = albedo;

	}

	outN = terrainPerturbNormal( p, N0, hdOut, 1.0 );

	s.albedo = albedoOut;
	s.roughness = outRough;
	s.normal = outN;
	s.ao = sat( outAO );
`;
