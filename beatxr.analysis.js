// Offline audio analysis: multi-band spectral flux -> onsets -> tempo + phase.
// Runs inside a worker; `onProgress` is called with 0..1 so the UI can show a bar.

import { fft, hannWindow } from './beatxr.fft.js';

export const ANALYSIS_RATE = 22050; // everything musically useful lives below ~11 kHz
const FFT_SIZE = 1024;
const HOP = 256; // ~11.6 ms -> 86 frames/sec

// Band edges in Hz. Low bands drive kick/bass placement, high bands drive hats/snares.
const BAND_EDGES = [30, 90, 180, 350, 700, 1400, 2800, 5600, 11000];
const BAND_COUNT = BAND_EDGES.length - 1;
// Perceptual weighting: bass and upper-mid transients read best as "beats".
const BAND_WEIGHTS = [1.3, 1.2, 0.9, 0.8, 0.9, 1.1, 1.1, 0.9];

/** Mix to mono and linearly resample to ANALYSIS_RATE. */
export function toMono(channels, sampleRate) {
  const len = channels[0].length;
  const ratio = sampleRate / ANALYSIS_RATE;
  const outLen = Math.floor(len / ratio);
  const out = new Float32Array(outLen);
  const nCh = channels.length;

  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = pos | 0;
    const i1 = Math.min(i0 + 1, len - 1);
    const frac = pos - i0;
    let sum = 0;
    for (let c = 0; c < nCh; c++) {
      const ch = channels[c];
      sum += ch[i0] + (ch[i1] - ch[i0]) * frac;
    }
    out[i] = sum / nCh;
  }
  return out;
}

/** Per-frame, per-band log energy. */
function bandEnergies(samples, onProgress) {
  const frameCount = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP));
  const win = hannWindow(FFT_SIZE);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  // Map each FFT bin to a band index once.
  const binHz = ANALYSIS_RATE / FFT_SIZE;
  const binBand = new Int8Array(FFT_SIZE / 2);
  const binsPerBand = new Float32Array(BAND_COUNT);
  for (let b = 0; b < FFT_SIZE / 2; b++) {
    const hz = b * binHz;
    let band = -1;
    for (let k = 0; k < BAND_COUNT; k++) {
      if (hz >= BAND_EDGES[k] && hz < BAND_EDGES[k + 1]) { band = k; break; }
    }
    binBand[b] = band;
    if (band >= 0) binsPerBand[band]++;
  }

  const energy = new Float32Array(frameCount * BAND_COUNT);
  const loudness = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const off = f * HOP;
    let rms = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[off + i];
      re[i] = s * win[i];
      im[i] = 0;
      rms += s * s;
    }
    loudness[f] = Math.sqrt(rms / FFT_SIZE);
    fft(re, im);

    const base = f * BAND_COUNT;
    for (let b = 1; b < FFT_SIZE / 2; b++) {
      const band = binBand[b];
      if (band < 0) continue;
      energy[base + band] += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
    }
    for (let k = 0; k < BAND_COUNT; k++) {
      energy[base + k] = Math.log1p(40 * (energy[base + k] / binsPerBand[k]));
    }

    if (onProgress && (f & 511) === 0) onProgress(0.05 + 0.55 * (f / frameCount));
  }

  return { energy, loudness, frameCount };
}

/** Positive first-order difference per band, plus a weighted sum envelope. */
function spectralFlux(energy, frameCount) {
  const bandFlux = new Float32Array(frameCount * BAND_COUNT);
  const envelope = new Float32Array(frameCount);

  for (let f = 1; f < frameCount; f++) {
    const base = f * BAND_COUNT;
    const prev = base - BAND_COUNT;
    let sum = 0;
    for (let k = 0; k < BAND_COUNT; k++) {
      const d = energy[base + k] - energy[prev + k];
      const v = d > 0 ? d : 0;
      bandFlux[base + k] = v;
      sum += v * BAND_WEIGHTS[k];
    }
    envelope[f] = sum;
  }
  return { bandFlux, envelope };
}

/** Rolling-median adaptive threshold; returns a smoothed detection function too. */
function pickPeaks(envelope, frameCount, sensitivity) {
  const fps = ANALYSIS_RATE / HOP;
  const half = Math.round(0.2 * fps); // +/- 200 ms median window
  const scratch = new Float32Array(half * 2 + 1);

  // Light smoothing kills double-triggers on soft attacks.
  const smooth = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const a = envelope[Math.max(0, f - 1)];
    const b = envelope[f];
    const c = envelope[Math.min(frameCount - 1, f + 1)];
    smooth[f] = 0.25 * a + 0.5 * b + 0.25 * c;
  }

  const peaks = [];
  const minGap = Math.round(0.06 * fps);
  let lastPeak = -minGap;

  for (let f = 1; f < frameCount - 1; f++) {
    const lo = Math.max(0, f - half);
    const hi = Math.min(frameCount - 1, f + half);
    const n = hi - lo + 1;
    for (let i = 0; i < n; i++) scratch[i] = smooth[lo + i];
    const slice = scratch.subarray(0, n);
    slice.sort();
    const median = slice[n >> 1];
    const mean = slice.reduce((s, v) => s + v, 0) / n;

    const threshold = median + sensitivity * (mean - median) + 0.02;
    const v = smooth[f];
    if (v < threshold) continue;
    if (v <= smooth[f - 1] || v < smooth[f + 1]) continue;
    if (f - lastPeak < minGap) {
      // Keep whichever of the two neighbours is stronger.
      const prev = peaks[peaks.length - 1];
      if (prev && v > prev.strength) { prev.frame = f; prev.strength = v; lastPeak = f; }
      continue;
    }
    peaks.push({ frame: f, strength: v });
    lastPeak = f;
  }

  // Normalise strengths to 0..1 against a high percentile so quiet tracks still chart.
  const sorted = peaks.map((p) => p.strength).sort((a, b) => a - b);
  const ref = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] || 1 : 1;
  for (const p of peaks) p.strength = Math.min(1, p.strength / ref);

  return peaks;
}

/** Autocorrelation of the onset envelope, resolved into a musically sane BPM. */
function estimateTempo(envelope, frameCount) {
  const fps = ANALYSIS_RATE / HOP;
  const minLag = Math.round(fps * 60 / 200); // 200 BPM
  const maxLag = Math.round(fps * 60 / 55);  // 55 BPM
  if (frameCount < maxLag * 2) return { bpm: 120, offset: 0, confidence: 0 };

  // Mean-remove so silence doesn't dominate the correlation.
  let mean = 0;
  for (let f = 0; f < frameCount; f++) mean += envelope[f];
  mean /= frameCount;
  const x = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) x[f] = envelope[f] - mean;

  const scores = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let f = 0; f + lag < frameCount; f++) sum += x[f] * x[f + lag];
    scores[lag] = sum / (frameCount - lag);
  }

  // Reinforce lags whose multiples also correlate -> picks the true beat, not a subdivision.
  const combed = new Float32Array(maxLag + 1);
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = scores[lag];
    for (const [mult, w] of [[2, 0.5], [3, 0.25], [4, 0.25]]) {
      const l = lag * mult;
      if (l <= maxLag) s += w * scores[l];
    }
    combed[lag] = s;
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }

  // One frame of lag is ~1.5 BPM at 130 BPM, so interpolate the correlation
  // peak parabolically instead of trusting the integer lag.
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = combed[bestLag - 1];
    const y1 = combed[bestLag];
    const y2 = combed[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      const shift = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(shift) < 1) refinedLag = bestLag + shift;
    }
  }

  let bpm = (60 * fps) / refinedLag;
  while (bpm < 85) bpm *= 2;
  while (bpm > 175) bpm /= 2;

  // Beat phase: try every offset within one beat, keep the one the onsets agree with.
  const period = (60 / bpm) * fps;
  let bestOffset = 0;
  let bestPhase = -Infinity;
  const steps = 64;
  for (let s = 0; s < steps; s++) {
    const off = (s / steps) * period;
    let sum = 0;
    for (let f = off; f < frameCount; f += period) {
      const i = Math.round(f);
      if (i < frameCount) sum += envelope[i];
    }
    if (sum > bestPhase) { bestPhase = sum; bestOffset = off; }
  }

  const confidence = Math.max(0, Math.min(1, bestScore / (scores[bestLag] * 4 + 1e-9)));
  return { bpm, offset: bestOffset / fps, confidence };
}

/** Coarse RMS peaks for the waveform strip in the menu. */
function waveformPeaks(samples, buckets = 900) {
  const out = new Float32Array(buckets);
  const size = Math.floor(samples.length / buckets);
  let max = 1e-6;
  for (let i = 0; i < buckets; i++) {
    let sum = 0;
    const start = i * size;
    for (let j = 0; j < size; j += 4) {
      const s = samples[start + j];
      sum += s * s;
    }
    out[i] = Math.sqrt(sum / (size / 4));
    if (out[i] > max) max = out[i];
  }
  for (let i = 0; i < buckets; i++) out[i] /= max;
  return out;
}

export function analyze(samples, { sensitivity = 1.4 } = {}, onProgress = null) {
  const fps = ANALYSIS_RATE / HOP;
  // A frame's energy is centred on its window, so its timestamp is the window
  // centre - without this every onset lands half a window early.
  const frameCentre = (FFT_SIZE / 2) / ANALYSIS_RATE;
  onProgress?.(0.05);

  const { energy, loudness, frameCount } = bandEnergies(samples, onProgress);
  onProgress?.(0.65);

  const { bandFlux, envelope } = spectralFlux(energy, frameCount);
  onProgress?.(0.72);

  const peaks = pickPeaks(envelope, frameCount, sensitivity);
  onProgress?.(0.85);

  const tempo = estimateTempo(envelope, frameCount);
  onProgress?.(0.95);

  // Attach a dominant band + local loudness to every onset; the generator uses
  // band for note height and loudness for density.
  const onsets = peaks.map((p) => {
    const base = p.frame * BAND_COUNT;
    let bestBand = 0;
    let bestVal = -1;
    for (let k = 0; k < BAND_COUNT; k++) {
      const v = bandFlux[base + k] * BAND_WEIGHTS[k];
      if (v > bestVal) { bestVal = v; bestBand = k; }
    }
    return {
      time: p.frame / fps + frameCentre,
      strength: p.strength,
      band: bestBand,
      loudness: loudness[p.frame],
    };
  });

  onProgress?.(1);
  return {
    onsets,
    bpm: tempo.bpm,
    beatOffset: tempo.offset + frameCentre,
    tempoConfidence: tempo.confidence,
    duration: samples.length / ANALYSIS_RATE,
    waveform: waveformPeaks(samples),
    bandCount: BAND_COUNT,
  };
}
