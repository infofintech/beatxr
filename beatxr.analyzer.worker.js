import { analyze, toMono } from './beatxr.analysis.js';

self.onmessage = (e) => {
  const { channels, sampleRate, sensitivity } = e.data;
  try {
    const mono = toMono(channels, sampleRate);
    const result = analyze(mono, { sensitivity }, (p) => {
      self.postMessage({ type: 'progress', value: p });
    });
    self.postMessage({ type: 'done', result }, [result.waveform.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
