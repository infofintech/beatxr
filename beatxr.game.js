// Gameplay: chart playback, saber/note collision, scoring, and the render loop.

import * as THREE from 'three';
import { DIR, DIR_VECTORS } from './beatxr.generator.js';
import { Environment } from './beatxr.environment.js';
import { NoteField } from './beatxr.notes.js';
import { SaberRig } from './beatxr.sabers.js';
import { Hud } from './beatxr.hud.js';

const COLORS = [0xff2b55, 0x2b8cff]; // left/red, right/blue
const MISS_Z = 0.62;         // a note this far past the player is gone
const JUDGE_NEAR = -1.1;     // start testing sabers once the note is this close
const MIN_SWING_SPEED = 2.0; // m/s at the saber tip
const GOOD_CUT_DOT = 0.5;    // ~60 degrees of tolerance on the arrow direction
const MULTIPLIER_STEPS = [[29, 8], [13, 4], [5, 2], [0, 1]];

function disposeTree(scene, root) {
  root.traverse((obj) => {
    obj.geometry?.dispose?.();
    const mat = obj.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose?.();
  });
  scene.remove(root);
}

export class Game {
  constructor(canvas, audio) {
    this.audio = audio;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.xr.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 120);
    this.camera.position.set(0, 1.6, 0.85);
    this.camera.lookAt(0, 1.25, -4);

    this._onResize = () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    };
    addEventListener('resize', this._onResize);

    this.chart = null;
    this.running = false;
    this.onEnd = null;
    this.onStats = null;
    this._lastFrame = 0;
    this._spectrum = { low: 0, mid: 0, high: 0 };
  }

  /** Safe to call repeatedly - the renderer, sabers and HUD are only built once. */
  build(chart, { heightOffset = 0, mirrorDesktop = true } = {}) {
    this.chart = chart;
    const spawnDistance = chart.njs * chart.reaction;

    if (!this.environment || Math.abs(spawnDistance - this.spawnDistance) > 0.01) {
      if (this.environment) disposeTree(this.scene, this.environment.group);
      this.environment = new Environment(this.scene, spawnDistance);
    }
    this.spawnDistance = spawnDistance;

    if (!this.field) {
      this.field = new NoteField(this.scene, COLORS, heightOffset);
      this.rig = new SaberRig(this.renderer, this.scene, this.camera, COLORS);
      this.hud = new Hud(this.scene);
    }
    this.field.heightOffset = heightOffset;
    this.rig.mirror = mirrorDesktop;

    this.reset();
  }

  reset() {
    for (const n of this.active || []) this.field.release(n.mesh);
    this.active = [];
    this.nextNote = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.multiplier = 1;
    this.hits = 0;
    this.misses = 0;
    this.badCuts = 0;
    this.energy = 0.5;
    this.finished = false;
    this.pausedAt = null;
  }

  async enterXR() {
    if (!navigator.xr) throw new Error('WebXR is not available in this browser.');
    const session = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['bounded-floor', 'hand-tracking', 'layers'],
    });
    await this.renderer.xr.setSession(session);
    session.addEventListener('end', () => { if (this.running) this.finish(); });
    // Headset taken off / system menu opened - freeze rather than rack up misses.
    session.addEventListener('visibilitychange', () => {
      if (session.visibilityState !== 'visible') this.pause();
    });
    return session;
  }

  start() {
    this.reset();
    this.startTime = this.audio.play(2.6);
    this.running = true;
    this._lastFrame = performance.now() / 1000;
    this.renderer.setAnimationLoop(() => this._frame());
  }

  stop() {
    this.running = false;
    this.pausedAt = null;
    this.renderer.setAnimationLoop(null);
    this.audio.stop();
  }

  /** Freeze the run. Without this, a backgrounded tab or a removed headset
   *  keeps the audio clock moving and every pending note becomes a miss. */
  pause() {
    if (!this.running) return;
    this.pausedAt = this.audio.songTime;
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.audio.stop();
    this.onPause?.();
  }

  get paused() { return !this.running && this.pausedAt != null && !this.finished; }

  /** Resume a little before the pause point so the player can re-read the lane. */
  resume(rewind = 1.8) {
    if (this.running || this.pausedAt == null) return;
    const from = Math.max(0, this.pausedAt - rewind);

    for (const entry of this.active) this.field.release(entry.mesh);
    this.active = [];
    this.nextNote = 0;
    const notes = this.chart.notes;
    while (this.nextNote < notes.length && notes[this.nextNote].time < from) this.nextNote++;

    this.pausedAt = null;
    this.startTime = this.audio.play(1.2, from);
    this.running = true;
    this._lastFrame = performance.now() / 1000;
    this.renderer.setAnimationLoop(() => this._frame());
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.stop();
    const total = this.hits + this.misses + this.badCuts;
    this.onEnd?.({
      score: this.score,
      maxCombo: this.maxCombo,
      hits: this.hits,
      misses: this.misses,
      badCuts: this.badCuts,
      accuracy: total ? this.hits / total : 0,
      notes: this.chart.notes.length,
    });
  }

  _frame() {
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, now - this._lastFrame);
    this._lastFrame = now;

    const songTime = this.audio.songTime;
    if (songTime > -0.4) this._spectrum = this.audio.spectrum();

    this.rig.update(dt);
    this._spawn(songTime);
    this._updateNotes(songTime, dt);
    this.field.updateEffects(dt);
    this.environment.update(dt, Math.max(0, songTime), this._spectrum);

    const countdown = songTime < 0 ? String(Math.max(1, Math.ceil(-songTime))) : '';
    this.hud.set({
      score: this.score,
      combo: this.combo,
      multiplier: this.multiplier,
      accuracy: this._accuracy(),
      energy: this.energy,
      message: countdown,
      progress: Math.max(0, Math.min(1, songTime / this.chart.duration)),
    });
    this.hud.update();

    if (!this.renderer.xr.isPresenting) {
      // Subtle camera sway keeps the desktop view from feeling static.
      this.camera.position.x = Math.sin(now * 0.4) * 0.03;
    }
    this.renderer.render(this.scene, this.camera);

    this.onStats?.({
      score: this.score, combo: this.combo, multiplier: this.multiplier,
      accuracy: this._accuracy(), energy: this.energy,
      time: songTime, duration: this.chart.duration,
    });

    if (songTime > this.chart.duration + 1.5 && this.active.length === 0) this.finish();
  }

  _accuracy() {
    const total = this.hits + this.misses + this.badCuts;
    return total ? this.hits / total : 1;
  }

  _spawn(songTime) {
    const notes = this.chart.notes;
    while (this.nextNote < notes.length && songTime >= notes[this.nextNote].time - this.chart.reaction) {
      const note = notes[this.nextNote++];
      const mesh = this.field.spawn(note);
      this.active.push({ note, mesh, cut: false, touched: false });
    }
  }

  _updateNotes(songTime, dt) {
    const njs = this.chart.njs;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const entry = this.active[i];
      const { note, mesh } = entry;
      const z = (songTime - note.time) * njs;
      mesh.position.z = z;

      // Pop-in scale so notes don't appear as hard rectangles in the fog.
      const age = songTime - (note.time - this.chart.reaction);
      if (age < 0.22) mesh.scale.setScalar(Math.max(0.05, age / 0.22));
      else mesh.scale.setScalar(1);

      if (z > MISS_Z) {
        this._registerMiss();
        this.field.release(mesh);
        this.active.splice(i, 1);
        continue;
      }

      if (z < JUDGE_NEAR) continue;
      this._testSabers(entry);
      if (entry.cut) {
        this.field.release(mesh);
        this.active.splice(i, 1);
      }
    }
  }

  _testSabers(entry) {
    const { note, mesh } = entry;
    for (const saber of this.rig.sabers) {
      const hit = NoteField.intersectSegment(mesh, saber.base, saber.tip);
      if (!hit) continue;

      if (saber.hand !== note.hand) {
        if (saber.speed > 1.2) { this._registerBadCut(); entry.cut = true; }
        return;
      }

      if (saber.speed < MIN_SWING_SPEED) { entry.touched = true; continue; }

      const v = saber.velocity;
      const len = Math.hypot(v.x, v.y);
      if (len < 1e-4) continue;
      const sx = v.x / len;
      const sy = v.y / len;

      let dot = 1;
      if (note.dir !== DIR.ANY) {
        const [rx, ry] = DIR_VECTORS[note.dir];
        dot = sx * rx + sy * ry;
        if (dot < GOOD_CUT_DOT) { this._registerBadCut(); entry.cut = true; return; }
      }

      // Cutting nearer the centre of the block scores better.
      const offCentre = Math.min(1, Math.hypot(hit.x, hit.y) / 0.22);
      this._registerHit(note, dot, offCentre);
      this.field.slice(mesh, note.hand, Math.atan2(v.y, v.x), new THREE.Vector3(sx, sy, 0));
      this.rig.pulse(note.hand, Math.min(1, 0.4 + saber.speed / 12), 55);
      entry.cut = true;
      return;
    }
  }

  _updateMultiplier() {
    for (const [threshold, mult] of MULTIPLIER_STEPS) {
      if (this.combo >= threshold) { this.multiplier = mult; return; }
    }
  }

  _registerHit(note, dot, offCentre) {
    this.hits++;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this._updateMultiplier();
    const quality = 0.75 + 0.25 * dot - 0.15 * offCentre;
    this.score += Math.round(100 * this.multiplier * Math.max(0.6, quality));
    this.energy = Math.min(1, this.energy + 0.02);
    this.audio.hit(0.6 + note.strength * 0.4, note.hand);
  }

  _registerMiss() {
    this.misses++;
    this._breakCombo();
  }

  _registerBadCut() {
    this.badCuts++;
    this._breakCombo();
  }

  _breakCombo() {
    if (this.combo > 2) this.audio.miss();
    this.combo = 0;
    this.multiplier = 1;
    this.energy = Math.max(0, this.energy - 0.1);
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.rig?.dispose();
    this.renderer.dispose();
  }
}
