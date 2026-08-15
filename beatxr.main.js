// UI glue: file -> decode -> analyse (worker) -> chart -> play.

import { AudioEngine } from './beatxr.audio.js';
import { generateChart, DIFFICULTIES } from './beatxr.generator.js';
import { Game } from './beatxr.game.js';

const $ = (id) => document.getElementById(id);
const el = {
  menu: $('menu'), results: $('results'), playHud: $('playHud'),
  drop: $('drop'), file: $('file'), dropTitle: $('dropTitle'),
  waveform: $('waveform'), progressWrap: $('progressWrap'), progressBar: $('progressBar'),
  songStats: $('songStats'), statLength: $('statLength'), statBpm: $('statBpm'),
  statOnsets: $('statOnsets'), statNotes: $('statNotes'), statNps: $('statNps'),
  difficulty: $('difficulty'), error: $('error'),
  sens: $('sens'), sensVal: $('sensVal'), dens: $('dens'), densVal: $('densVal'),
  njs: $('njs'), njsVal: $('njsVal'), height: $('height'), heightVal: $('heightVal'),
  vol: $('vol'), volVal: $('volVal'),
  playVR: $('playVR'), playDesktop: $('playDesktop'), regen: $('regen'),
  rank: $('rank'), rScore: $('rScore'), rAcc: $('rAcc'), rCombo: $('rCombo'), rCounts: $('rCounts'),
  again: $('again'), back: $('back'),
  pause: $('pause'), pauseAt: $('pauseAt'), resume: $('resume'), quit: $('quit'),
};

const audio = new AudioEngine();
let game = null;
let analysis = null;
let chart = null;
let difficulty = 'normal';
let songName = '';
let worker = null;

/* ---------------------------------------------------------------- menu UI */

for (const [key, cfg] of Object.entries(DIFFICULTIES)) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = cfg.label;
  b.dataset.key = key;
  b.setAttribute('aria-pressed', String(key === difficulty));
  b.onclick = () => {
    difficulty = key;
    for (const other of el.difficulty.children) {
      other.setAttribute('aria-pressed', String(other.dataset.key === key));
    }
    el.njs.value = DIFFICULTIES[key].njs;
    el.njsVal.textContent = `${DIFFICULTIES[key].njs} m/s`;
    if (analysis) rechart();
  };
  el.difficulty.appendChild(b);
}
el.njs.value = DIFFICULTIES[difficulty].njs;
el.njsVal.textContent = `${DIFFICULTIES[difficulty].njs} m/s`;

el.sens.oninput = () => { el.sensVal.textContent = Number(el.sens.value).toFixed(2); };
el.dens.oninput = () => { el.densVal.textContent = `${Number(el.dens.value).toFixed(2)}×`; if (analysis) rechart(); };
el.njs.oninput = () => { el.njsVal.textContent = `${el.njs.value} m/s`; if (analysis) rechart(); };
el.height.oninput = () => { el.heightVal.textContent = `${Number(el.height.value).toFixed(2)} m`; };
el.vol.oninput = () => {
  el.volVal.textContent = `${Math.round(el.vol.value * 100)}%`;
  audio.setVolume(Number(el.vol.value));
};
audio.setVolume(Number(el.vol.value));

// Sensitivity changes require re-running the analysis, not just re-charting.
el.sens.onchange = () => { if (audio.buffer) runAnalysis(); };

el.drop.onclick = () => el.file.click();
el.drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') el.file.click(); };
el.file.onchange = () => { if (el.file.files[0]) loadFile(el.file.files[0]); };

for (const type of ['dragenter', 'dragover']) {
  el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.remove('over'); });
}
el.drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

/* ------------------------------------------------------------ analysis */

async function loadFile(file) {
  setError('');
  el.dropTitle.textContent = file.name;
  songName = file.name.replace(/\.[^.]+$/, '');
  setBusy(true, 0);
  try {
    await audio.resume();
    const bytes = await file.arrayBuffer();
    await audio.decode(bytes);
    await runAnalysis();
  } catch (err) {
    console.error(err);
    setError(`Could not read that file: ${err.message || err}`);
    setBusy(false);
  }
}

function runAnalysis() {
  return new Promise((resolve, reject) => {
    setBusy(true, 0.02);
    worker?.terminate();
    worker = new Worker(new URL('./beatxr.analyzer.worker.js', import.meta.url), { type: 'module' });

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') { setBusy(true, msg.value); return; }
      if (msg.type === 'error') {
        setError(`Analysis failed: ${msg.message}`);
        setBusy(false);
        reject(new Error(msg.message));
        return;
      }
      analysis = msg.result;
      drawWaveform(analysis.waveform);
      rechart();
      setBusy(false);
      enablePlay(true);
      resolve();
    };

    const buf = audio.buffer;
    const channels = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
      channels.push(new Float32Array(buf.getChannelData(c)));
    }
    worker.postMessage(
      { channels, sampleRate: buf.sampleRate, sensitivity: Number(el.sens.value) },
      channels.map((c) => c.buffer)
    );
  });
}

function rechart() {
  if (!analysis) return;
  chart = generateChart(analysis, difficulty, { densityScale: Number(el.dens.value) });
  chart.njs = Number(el.njs.value);
  showStats();
}

function showStats() {
  el.songStats.hidden = false;
  el.statLength.textContent = formatTime(analysis.duration);
  el.statBpm.textContent = `${analysis.bpm.toFixed(1)} BPM`;
  el.statOnsets.textContent = analysis.onsets.length;
  el.statNotes.textContent = chart.notes.length;
  el.statNps.textContent = `${chart.nps.toFixed(2)} / s`;
  el.regen.disabled = false;
}

function drawWaveform(peaks) {
  const c = el.waveform;
  const g = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  g.clearRect(0, 0, w, h);
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#ff2b55');
  grad.addColorStop(0.5, '#6f5cff');
  grad.addColorStop(1, '#2affd5');
  g.fillStyle = grad;
  const bw = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const bh = Math.max(2, peaks[i] * h * 0.92);
    g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.6), bh);
  }
}

/* -------------------------------------------------------------- play */

function ensureGame() {
  if (!game) {
    game = new Game(document.getElementById('scene'), audio);
    game.onEnd = showResults;
    game.onPause = showPause;
  }
  game.build(chart, { heightOffset: Number(el.height.value), mirrorDesktop: true });
  return game;
}

async function startDesktop() {
  await audio.resume();
  ensureGame();
  el.menu.hidden = true;
  el.results.hidden = true;
  el.pause.hidden = true;
  el.playHud.classList.add('on');
  game.start();
}

async function startVR() {
  setError('');
  try {
    await audio.resume();
    ensureGame();
    await game.enterXR();
    el.menu.hidden = true;
    el.results.hidden = true;
    el.playHud.classList.remove('on');
    game.start();
  } catch (err) {
    console.error(err);
    setError(`Could not start VR: ${err.message || err}. Playing on desktop still works.`);
  }
}

function showPause() {
  el.pause.hidden = false;
  el.playHud.classList.remove('on');
  const t = game?.pausedAt ?? 0;
  el.pauseAt.textContent = `${formatTime(Math.max(0, t))} of ${formatTime(chart.duration)}`;
}

function resumeRun() {
  if (!game?.paused) return;
  el.pause.hidden = true;
  if (!game.renderer.xr.isPresenting) el.playHud.classList.add('on');
  game.resume();
}

function quitRun() {
  if (!game) return;
  game.stop();
  el.pause.hidden = true;
  el.playHud.classList.remove('on');
  el.menu.hidden = false;
}

el.resume.onclick = resumeRun;
el.quit.onclick = quitRun;

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (game?.running) game.pause();
  else if (game?.paused) resumeRun();
});

// A hidden tab still runs the audio clock, so freeze instead of eating the chart.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game?.running) game.pause();
});

function showResults(r) {
  el.playHud.classList.remove('on');
  el.pause.hidden = true;
  el.results.hidden = false;
  el.rScore.textContent = r.score.toLocaleString();
  el.rAcc.textContent = `${Math.round(r.accuracy * 100)}%`;
  el.rCombo.textContent = r.maxCombo;
  el.rCounts.textContent = `${r.hits} / ${r.misses} / ${r.badCuts}`;
  el.rank.textContent = rankFor(r.accuracy);
}

function rankFor(acc) {
  if (acc >= 0.95) return 'SS';
  if (acc >= 0.9) return 'S';
  if (acc >= 0.8) return 'A';
  if (acc >= 0.65) return 'B';
  if (acc >= 0.5) return 'C';
  return 'D';
}

el.playDesktop.onclick = startDesktop;
el.playVR.onclick = startVR;
el.regen.onclick = () => { rechart(); };
el.again.onclick = () => {
  el.results.hidden = true;
  // Stay in whichever mode the last run used.
  if (game?.renderer.xr.isPresenting) { ensureGame(); game.start(); }
  else startDesktop();
};
el.back.onclick = () => { el.results.hidden = true; el.menu.hidden = false; };

/* ------------------------------------------------------------ helpers */

function setBusy(busy, progress = 0) {
  el.progressWrap.hidden = !busy;
  el.progressBar.style.width = `${Math.round(progress * 100)}%`;
  if (busy) enablePlay(false);
}

function enablePlay(on) {
  el.playDesktop.disabled = !on;
  el.playVR.disabled = !on || !navigator.xr;
  el.regen.disabled = !on;
}

function setError(msg) { el.error.textContent = msg; }

function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// Handle for poking at a run from the console: beatxr.chart, beatxr.analysis, etc.
window.beatxr = {
  audio,
  get game() { return game; },
  get chart() { return chart; },
  get analysis() { return analysis; },
};

// Advertise VR availability up front.
if (navigator.xr?.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) el.playVR.textContent = 'Enter VR (no headset detected)';
  }).catch(() => {});
} else {
  el.playVR.textContent = 'Enter VR (unsupported browser)';
}
