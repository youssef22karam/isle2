              (rnd() * 6) | 0,
              ux,
              uy - 0.06,
              uz,
              us,
              us * 0.9,
              us,
              rnd() * TAU,
              0,
              0,
              ur,
              ug,
              ub,
            );
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // B) SCENIC ROCKY OUTCROPS & GREEN BLUFF CROWNS ALONG LAKES & RIVERS
  // ---------------------------------------------------------------------------
  for (let iz = 4; iz < N - 4; iz += 3) {
    for (let ix = 4; ix < N - 4; ix += 3) {
      const k = iz * N + ix;
      if (!fresh || fresh[k] < 0.22 || wet[k]) continue;
      const sw = swamp ? swamp[k] : 0;
      if (sw > 0.3) continue;

      const x = xOf(ix) + (rnd() - 0.5) * cell * 2;
      const z = zOf(iz) + (rnd() - 0.5) * cell * 2;
      const kc = cellAt(x, z);
      if (kc < 0 || wet[kc] || isNavBlocked(x, z, 16)) continue;

      const y = sampleH(x, z);
      const bankH = y - (nearLevel ? nearLevel[kc] : 0);
      if (bankH < 0.25 || bankH > 42) continue;

      const gx = (sampleH(x + 4, z) - sampleH(x - 4, z)) / 8;
      const gz = (sampleH(x, z + 4) - sampleH(x, z - 4)) / 8;
      const slope = Math.hypot(gx, gz);

      // Sculpted rocky bluff outcrops & mossy shore boulders framing lakes & rivers
      if ((slope > 0.32 || (bankH < 2.8 && nz.val(x / 42, z / 42) > 0.64)) && rnd() < 0.22) {
        const rs = 1.15 + Math.pow(rnd(), 0.8) * (slope > 0.4 ? 3.2 : 1.9);
        const fy = footH(x, z, rs * 0.35);
        if (fy > -0.2) {
          const tone = 0.38 + rnd() * 0.2;
          emit(
            rnd() < 0.36 ? "slab" : "rock",
            (rnd() * 12) | 0,
            x,
            fy - rs * 0.1,
            z,
            rs * (1.0 + rnd() * 0.35),
            rs * (0.62 + rnd() * 0.52),
            rs * (0.92 + rnd() * 0.32),
            rnd() * TAU,
            (rnd() - 0.5) * 0.24,
            (rnd() - 0.5) * 0.24,
            tone * 1.03,
            tone * 1.0,
            tone * 0.92,
          );
          if (rs > 1.8 && fy > 0.9 && rnd() < 0.65) {
            const [cr, cg, cb] = hslToRgb(0.25 + rnd() * 0.04, 0.46, 0.36 + rnd() * 0.1);
            const fs = 0.65 + rnd() * 0.7;
            emit(
              rnd() < 0.5 ? "fern" : "shrub",
              (rnd() * 6) | 0,
              x + (rnd() - 0.5) * rs * 0.3,
              fy + rs * 0.38,
              z + (rnd() - 0.5) * rs * 0.3,
              fs,
              fs * 0.9,
              fs,
              rnd() * TAU,
              0,
              0,
              cr,
              cg,
              cb,
            );
          }
        }
      }
    }
  }
}
