// Song playback (the clock the whole game runs on) plus synthesised hit feedback.

export class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    this.musicGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    this.musicGain.connect(this.analyser);
    this.analyser.connect(this.master);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.35;
    this.sfxGain.connect(this.master);

    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.source = null;
    this.startTime = 0;
    this.buffer = null;
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async decode(arrayBuffer) {
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return this.buffer;
  }

  /** Starts the song `lead` seconds from now and returns the audio-clock start time. */
  play(lead = 2.2, offset = 0) {
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.musicGain);
    this.startTime = this.ctx.currentTime + lead - offset;
    src.start(this.ctx.currentTime + lead, offset);
    this.source = src;
    return this.startTime;
  }

  stop() {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  /** Seconds into the song; negative during the lead-in countdown. */
  get songTime() {
    return this.ctx.currentTime - this.startTime;
  }

  setVolume(v) {
    this.musicGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Energy in the low / mid / high thirds of the spectrum, 0..1, for reactive visuals. */
  spectrum() {
    this.analyser.getByteFrequencyData(this.freqData);
    const n = this.freqData.length;
    let low = 0, mid = 0, high = 0;
    const a = Math.floor(n * 0.12), b = Math.floor(n * 0.45);
    for (let i = 0; i < a; i++) low += this.freqData[i];
    for (let i = a; i < b; i++) mid += this.freqData[i];
    for (let i = b; i < n; i++) high += this.freqData[i];
    return {
      low: low / (a * 255),
      mid: mid / ((b - a) * 255),
      high: high / ((n - b) * 255),
    };
  }

  hit(strength = 1, hand = 0) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = hand === 0 ? 1400 : 1900;
    filter.Q.value = 1.2;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(hand === 0 ? 620 : 780, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5 * strength + 0.05, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    osc.connect(filter); filter.connect(gain); gain.connect(this.sfxGain);
    osc.start(t); osc.stop(t + 0.15);
  }

  miss() {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.18);
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain); gain.connect(this.sfxGain);
    osc.start(t); osc.stop(t + 0.22);
  }
}
