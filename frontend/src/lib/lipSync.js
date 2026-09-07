// Derives mouth opening and the two authored EE/OO shapes from the agent's
// outgoing audio. Timing comes from the waveform; the spectral balance picks
// a plausible wide or rounded vowel instead of cycling shapes on a timer.

// Silence is never truly silent: stream hiss and room tone sit a little above
// zero, and anything above this floor holds her mouth open. Raised from 0.012,
// which was low enough that she never fully closed between words.
const NOISE_FLOOR = 0.010;
const GAIN = 52;

function smoothstep(lo, hi, value) {
  const x = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return x * x * (3 - 2 * x);
}

export class LipSync {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buffer = null;
    this.freq = null;
    this.source = null;
    this._ee = 0;
    this._oo = 0;
    this._lastLevel = 0;
    this._viseme = 'neutral';
    this._changedAt = 0;
  }

  // Chrome will not route a remote WebRTC track through Web Audio unless the
  // stream is also attached to a playing media element. The caller owns that
  // element; we only tap the stream.
  attach(stream) {
    if (!stream) return false;
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this.detach();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.16;
    this.buffer = new Uint8Array(this.analyser.fftSize);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
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

  _bandPower(lo, hi) {
    const hzPerBin = this.ctx.sampleRate / this.analyser.fftSize;
    const from = Math.max(1, Math.floor(lo / hzPerBin));
    const to = Math.min(this.freq.length, Math.ceil(hi / hzPerBin));
    let sum = 0;
    for (let i = from; i < to; i++) sum += Math.pow(10, this.freq[i] / 10);
    return sum / Math.max(1, to - from);
  }

  // Returns a speech sample. `level` controls jaw opening; EE and OO are
  // continuous shape weights. Call once per animation frame.
  read() {
    if (!this.analyser) return { level: 0, viseme: 'neutral', ee: 0, oo: 0 };
    this.analyser.getByteTimeDomainData(this.buffer);

    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const v = (this.buffer[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.buffer.length);
    const level = rms < NOISE_FLOOR ? 0 : Math.min(1, (rms - NOISE_FLOOR) * GAIN);

    if (level <= 0.025) {
      this._ee *= 0.35;
      this._oo *= 0.35;
      this._lastLevel = level;
      this._viseme = 'neutral';
      return { level: 0, viseme: 'neutral', ee: this._ee, oo: this._oo };
    }

    this.analyser.getFloatFrequencyData(this.freq);
    const low = this._bandPower(220, 900);
    const mid = this._bandPower(900, 2600);
    const high = this._bandPower(2600, 7000);
    const voiced = low + mid + 1e-12;
    const frontness = mid / voiced;
    const roundness = low / voiced;
    const sibilance = high / (voiced + high + 1e-12);

    let ee = smoothstep(0.38, 0.68, frontness) * (1 - sibilance * 0.45);
    let oo = smoothstep(0.60, 0.84, roundness) * (1 - sibilance * 0.70);
    if (sibilance > 0.50) ee = Math.max(ee, 0.30);
    if (ee > 0.12 && oo > 0.12) {
      if (ee > oo) oo *= 0.28;
      else ee *= 0.28;
    }
    this._ee += (ee - this._ee) * 0.42;
    this._oo += (oo - this._oo) * 0.42;

    let pick = this._ee > this._oo ? 'EE' : 'OO';
    if (Math.max(this._ee, this._oo) < 0.16) pick = 'AA';
    if (level < 0.10 && this._lastLevel > 0.20) pick = 'BMP';
    const now = performance.now();
    if (pick !== this._viseme && now - this._changedAt > 42) {
      this._viseme = pick;
      this._changedAt = now;
    }
    this._lastLevel = level;
    return { level, viseme: this._viseme, ee: this._ee, oo: this._oo };
  }

  close() {
    this.detach();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}
