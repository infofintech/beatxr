# BeatXR

A WebXR rhythm game in the Beat Saber mould. Drop in any audio file and it
analyses the track, estimates the tempo, and generates a beat-synced level you
can play with VR controllers — or with a mouse if you don't have a headset.

Everything runs locally in the browser. No audio is uploaded anywhere.

**▶ Play: <https://chezburgar.github.io/beatxr/>**

Open that URL in a headset browser (Quest, Pico, WMR) and press *Enter VR* — Pages
serves over HTTPS, which is the secure context WebXR requires.

## Running it locally

The site is fully static with no build step, so any static server works:

```bash
node server.js
```

Then open <http://localhost:5173>. WebXR also accepts `localhost` as a secure
context, so this works without certificates.

three.js r170 is vendored in `vendor/` (MIT — see `vendor/three.LICENSE`), so the
game is self-contained: no CDN, no install step, and it runs offline. `npm install`
is optional and only pins the version the vendored file came from.

## How the chart is generated

The whole pipeline lives in `src/` and runs in a worker so the UI stays responsive.

1. **Decode & resample** (`analysis.js`) — the file is decoded with the Web Audio
   API, mixed to mono and resampled to 22.05 kHz. Everything musically useful for
   onset detection lives below ~11 kHz, and halving the rate halves the FFT cost.

2. **Spectral flux** — a 1024-point FFT every 256 samples (~86 frames/sec, via the
   hand-rolled radix-2 FFT in `fft.js`). Each frame's spectrum is collapsed into 8
   log-spaced bands, and the positive frame-to-frame energy difference per band
   gives a multi-band onset envelope. Frames are timestamped at their window
   *centre*, not their start — otherwise every onset lands half a window early.

3. **Peak picking** — a rolling median over a ±200 ms window forms an adaptive
   threshold, so quiet passages still produce notes and loud ones don't produce
   mush. Peaks closer than 60 ms collapse into whichever was stronger.

4. **Tempo & phase** — autocorrelation of the onset envelope over the 55–200 BPM
   range, with the correlation at each lag reinforced by its 2×/3×/4× multiples so
   the estimate locks onto the beat rather than a subdivision. The peak is
   interpolated parabolically (one frame of lag is ~1.5 BPM at 130 BPM), then
   folded into 85–175 BPM. Beat phase is whichever offset the onsets agree with.

5. **Charting** (`generator.js`) — onsets snap to the nearest 1/4 beat when
   they're already close, get thinned to the difficulty's minimum spacing and
   density cap, then become notes:
   - **Height** comes from the onset's dominant frequency band — bass sits on the
     bottom row, hats and cymbals on the top.
   - **Hand** alternates through streams, with longer phrases allowed to stay on
     one hand when the gap is wide.
   - **Direction** follows a flow model: consecutive same-hand notes alternate
     swing direction, big lane jumps become diagonals, and anything under 140 ms
     is forced into a clean reversal so it stays physically possible.
   - Loud isolated hits become two-hand chords, and simultaneous notes get
     un-crossed so your arms never have to swap sides.

Measured against synthetic click tracks, tempo lands within 1 BPM at 92/128/174
BPM and onsets within ~10 ms of the true grid.

## Playing

**VR** — press *Enter VR*. A `local-floor` reference space is requested, so stand
up and give yourself an arm's length of clearance. Cut each block in the direction
its arrow points, with the matching colour; dot blocks accept any direction.

**Desktop** — the mouse drives the saber on whichever side the cursor is on, and
the other saber mirrors it, so lane colours always line up. It's a practice mode,
not a replacement for real controllers.

`Esc` pauses. Resuming rewinds ~1.8 s so you can pick the lane back up. Taking the
headset off or backgrounding the tab pauses automatically rather than burning
through the chart.

## Tuning

- **Detection sensitivity** — raises or lowers the onset threshold. Re-runs the
  analysis. Lower it for sparse/ambient tracks, raise it for busy mixes.
- **Note density** — scales the spacing and density cap without re-analysing.
- **Approach speed** — how fast notes fly at you (m/s). Higher means more reaction
  time distance-wise but a shorter window at the cut plane.
- **Height offset** — shifts the whole note field up or down for seated play or
  for players well outside average height.

`window.beatxr` exposes `{ audio, game, chart, analysis }` for poking at a run
from the console.

## Layout

| File | Role |
| --- | --- |
| `src/fft.js` | Iterative radix-2 FFT + Hann window |
| `src/analysis.js` | Band energies, spectral flux, peak picking, tempo/phase |
| `src/analyzer.worker.js` | Runs the analysis off the main thread |
| `src/generator.js` | Onsets → chart, difficulty presets, flow model |
| `src/game.js` | Chart playback, collision, scoring, render loop |
| `src/notes.js` | Note pool, arrow decals, segment/OBB test, slice debris |
| `src/sabers.js` | XR controllers + desktop mouse rig |
| `src/environment.js` | Reactive grid, rings and rails |
| `src/hud.js` | World-locked canvas HUD |
| `src/main.js` | Menu, file loading, run lifecycle |
| `server.js` | Zero-dependency static server for local play |

## Known limitations

- No walls or bombs — notes only.
- Tempo estimation assumes a roughly constant tempo. Rubato and live recordings
  still chart (onsets don't depend on the grid), but the 1/4-beat quantisation
  stops helping.
- Variable-tempo and heavily syncopated tracks chart better with sensitivity
  raised and quantisation effectively bypassed by the tolerance check.
- Scoring is simplified: no swing-angle accuracy tracking before/after the cut
  like the real game, just direction match and distance from block centre.
