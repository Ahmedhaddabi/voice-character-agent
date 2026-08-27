// Picks a mouth shape from live audio.
//
// Amplitude alone can only say "open this much" — it cannot tell an "ee" from
// an "oh". Vowels are distinguished by their first two formants, so this reads
// where the spectral energy sits and maps that onto the sprite set.
//
// It is an approximation, not phoneme recognition. It does not need to be
// exact: viewers judge lip sync by timing far more than by shape accuracy, and
// the timing here is sample-accurate.

const BANDS = {
  f1: [250, 900],     // jaw openness — high energy here means an open mouth
  f2: [900, 2600],    // tongue position — high means front vowels like "ee"
  hiss: [3800, 8500], // sibilants: s, sh, ch, z
};

const HOLD_MS = 55;   // minimum time on a shape, stops strobing
const SILENCE = 0.020;

export class VisemeAnalyser {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.freq = null;
    this.time = null;
    this.source = null;
    this.current = 'neutral';
    this.level = 0;
    this._changedAt = 0;
  }

  attach(stream) {
    if (!stream) return false;
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.detach();

    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.35;
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.time = new Uint8Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    return true;
  }

  detach() {
    if (this.source) {
      try { this.source.disconnect(); } catch { /* already gone */ }
      this.source = null;
    }
    this.analyser = null;
  }

  _bandEnergy(lo, hi) {
    const nyquist = this.ctx.sampleRate / 2;
    const perBin = nyquist / this.freq.length;
    let sum = 0, n = 0;
    for (let i = Math.floor(lo / perBin); i < Math.min(this.freq.length, Math.ceil(hi / perBin)); i++) {
      sum += Math.pow(10, this.freq[i] / 20); // dB back to linear
      n++;
    }
    return n ? sum / n : 0;
  }

  // Returns { viseme, level } — level is 0..1 amplitude for scaling.
  read() {
    if (!this.analyser) return { viseme: 'neutral', level: 0 };

    this.analyser.getByteTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.time.length);
    this.level = rms < SILENCE ? 0 : Math.min(1, (rms - SILENCE) * 26);

    if (this.level <= 0) {
      this.current = 'neutral';
      return { viseme: 'neutral', level: 0 };
    }

    this.analyser.getFloatFrequencyData(this.freq);
    const f1 = this._bandEnergy(...BANDS.f1);
    const f2 = this._bandEnergy(...BANDS.f2);
    const hiss = this._bandEnergy(...BANDS.hiss);
    const total = f1 + f2 + hiss || 1e-9;

    let pick;
    if (hiss / total > 0.42) {
      // Sibilant: narrow mouth, teeth showing.
      pick = hiss / total > 0.60 ? 'CDNST' : 'CHJSH';
    } else {
      const ratio = f2 / (f1 || 1e-9);
      const open = this.level;
      if (ratio > 1.15) {
        pick = open > 0.45 ? 'EE' : 'CDNST';      // front vowels, wide
      } else if (ratio > 0.55) {
        pick = open > 0.55 ? 'AEI' : 'L';          // open central vowels
      } else {
        pick = open > 0.5 ? 'O' : 'U';             // back rounded vowels
      }
      if (open < 0.14) pick = 'BMP';               // near-closed: lips together
    }

    const now = performance.now();
    if (pick !== this.current && now - this._changedAt > HOLD_MS) {
      this.current = pick;
      this._changedAt = now;
    }
    return { viseme: this.current, level: this.level };
  }

  close() {
    this.detach();
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
  }
}
