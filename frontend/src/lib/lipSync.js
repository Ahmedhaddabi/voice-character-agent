// Hybrid live lip-sync for the agent's outgoing WebRTC audio.
//
// The waveform remains the timing authority: it decides exactly when the jaw
// opens and closes. Spectral balance suggests a mouth shape, while streaming
// output transcript deltas provide a low-confidence phoneme hint. Keeping the
// two signals separate avoids "reading" ahead of the audible speech.

const VISEMES = ['AA', 'EE', 'OO', 'UW', 'FV', 'LTH', 'SZ', 'BMP'];
const EMPTY_WEIGHTS = Object.fromEntries(VISEMES.map((name) => [name, 0]));
const MIN_GATE = 0.0035;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(lo, hi, value) {
  const x = clamp01((value - lo) / (hi - lo));
  return x * x * (3 - 2 * x);
}

function pushToken(tokens, viseme, duration = 78) {
  const last = tokens[tokens.length - 1];
  if (last?.viseme === viseme && viseme !== 'BMP') {
    last.duration = Math.min(150, last.duration + duration * 0.55);
  } else {
    tokens.push({ viseme, duration });
  }
}

// English graphemes are only a hint, not a phonetic transcription. The live
// spectrum is still blended in so names, accents, and other languages remain
// animated instead of following an incorrect spelling literally.
export function textToVisemes(text) {
  const tokens = [];
  const input = String(text ?? '').toLowerCase();
  for (let i = 0; i < input.length;) {
    const pair = input.slice(i, i + 2);
    if (pair === 'th') { pushToken(tokens, 'LTH', 82); i += 2; continue; }
    if (['sh', 'ch', 'zh'].includes(pair)) { pushToken(tokens, 'SZ', 76); i += 2; continue; }
    if (pair === 'ph') { pushToken(tokens, 'FV', 72); i += 2; continue; }
    if (['oo', 'ew'].includes(pair)) { pushToken(tokens, 'UW', 96); i += 2; continue; }
    if (['ou', 'ow'].includes(pair)) { pushToken(tokens, 'OO', 94); i += 2; continue; }
    if (['ee', 'ea'].includes(pair)) { pushToken(tokens, 'EE', 96); i += 2; continue; }
    if (pair === 'qu') { pushToken(tokens, 'UW', 82); i += 2; continue; }

    const ch = input[i++];
    if (/\s/.test(ch)) { pushToken(tokens, 'neutral', 48); continue; }
    if (/[,.!?;:]/.test(ch)) { pushToken(tokens, 'neutral', 90); continue; }
    if (/[bmp]/.test(ch)) pushToken(tokens, 'BMP', 62);
    else if (/[fv]/.test(ch)) pushToken(tokens, 'FV', 68);
    else if (/[szx]/.test(ch)) pushToken(tokens, 'SZ', 68);
    else if (/[lrdtn]/.test(ch)) pushToken(tokens, 'LTH', 66);
    else if (/[eiy]/.test(ch)) pushToken(tokens, 'EE', 86);
    else if (ch === 'o') pushToken(tokens, 'OO', 90);
    else if (/[uwq]/.test(ch)) pushToken(tokens, 'UW', 86);
    else if (ch === 'a') pushToken(tokens, 'AA', 92);
    else if (/[hkgcj]/.test(ch)) pushToken(tokens, 'AA', 62);
  }
  return tokens;
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
    this._level = 0;
    this._lastLevel = 0;
    this._noiseRms = MIN_GATE * 0.55;
    this._peakRms = 0.055;
    this._viseme = 'neutral';
    this._changedAt = 0;
    this._weights = { ...EMPTY_WEIGHTS };
    this._speechActive = false;
    this._hintQueue = [];
    this._hint = null;
    this._hintChangedAt = 0;
    this._lastSample = this._silentSample();
  }

  _silentSample() {
    return {
      level: 0,
      rms: 0,
      viseme: 'neutral',
      hint: this._hint?.viseme ?? 'neutral',
      queueDepth: this._hintQueue.length,
      speechActive: this._speechActive,
      ee: 0,
      oo: 0,
      weights: { ...EMPTY_WEIGHTS },
    };
  }

  // Chrome needs the remote stream on a playing media element. The caller
  // owns that element; this class adds a silent Web Audio analysis tap.
  attach(stream) {
    if (!stream) return false;
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this.detach();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.08;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -12;
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

  beginUtterance() {
    if (this._speechActive) return;
    this._speechActive = true;
    this._hintQueue.length = 0;
    this._hint = null;
    this._hintChangedAt = 0;
  }

  endUtterance() {
    this._speechActive = false;
  }

  interrupt() {
    this._speechActive = false;
    this._hintQueue.length = 0;
    this._hint = null;
    this._hintChangedAt = 0;
    this._level = 0;
    this._lastLevel = 0;
    this._viseme = 'neutral';
    for (const name of VISEMES) this._weights[name] = 0;
  }

  enqueueTranscript(delta) {
    // WebRTC plays audio internally and some SDK versions do not emit the
    // high-level audio_start event. A transcript delta is therefore also a
    // reliable signal that a new spoken response has begun.
    if (!this._speechActive) this.beginUtterance();
    const tokens = textToVisemes(delta);
    if (!tokens.length) return;
    this._hintQueue.push(...tokens);
    // A long response can otherwise leave old hints playing after their word.
    if (this._hintQueue.length > 160) this._hintQueue.splice(0, this._hintQueue.length - 160);
  }

  _advanceHint(now, level, rise) {
    const elapsed = now - this._hintChangedAt;
    const expired = !this._hint || elapsed >= this._hint.duration;
    const syllableOnset = rise > 0.075 && elapsed > 42;
    if ((expired || syllableOnset) && this._hintQueue.length) {
      this._hint = this._hintQueue.shift();
      this._hintChangedAt = now;
    }
    // Do not let an early transcript pull the mouth through vowels in silence.
    if (level < 0.025 && this._hint?.viseme !== 'BMP') return 'neutral';
    return this._hint?.viseme ?? 'neutral';
  }

  _bandPower(lo, hi) {
    const hzPerBin = this.ctx.sampleRate / this.analyser.fftSize;
    const from = Math.max(1, Math.floor(lo / hzPerBin));
    const to = Math.min(this.freq.length, Math.ceil(hi / hzPerBin));
    let sum = 0;
    for (let i = from; i < to; i++) sum += Math.pow(10, this.freq[i] / 10);
    return sum / Math.max(1, to - from);
  }

  _decayToSilence(rms, hint) {
    this._ee *= 0.38;
    this._oo *= 0.38;
    for (const name of VISEMES) this._weights[name] *= name === 'BMP' && hint === 'BMP' ? 0.82 : 0.30;
    this._viseme = hint === 'BMP' ? 'BMP' : 'neutral';
    const sample = {
      level: 0,
      rms,
      viseme: this._viseme,
      hint,
      queueDepth: this._hintQueue.length,
      speechActive: this._speechActive,
      ee: this._ee,
      oo: this._oo,
      weights: { ...this._weights },
    };
    this._lastSample = sample;
    return sample;
  }

  // Returns one speech sample per animation frame. `level` drives the bones;
  // continuous `weights` drive the eight authored morph targets.
  read() {
    if (!this.analyser) return this._silentSample();
    this.analyser.getByteTimeDomainData(this.buffer);

    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const v = (this.buffer[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.buffer.length);

    // Adapt to quiet/loud voices and browser volume. The floor follows only
    // low-energy frames; the peak falls slowly so an entire sentence keeps a
    // stable jaw range rather than pumping from syllable to syllable.
    if (rms < Math.max(0.012, this._noiseRms * 2.2)) {
      this._noiseRms += (rms - this._noiseRms) * 0.025;
    }
    this._peakRms = Math.max(rms, this._peakRms * 0.9982, 0.028);
    const gate = Math.max(MIN_GATE, this._noiseRms * 2.15);
    const reference = Math.max(gate + 0.020, this._peakRms * 0.72);
    const rawLevel = rms <= gate ? 0 : smoothstep(gate, reference, rms);
    const levelRate = rawLevel > this._level ? 0.68 : 0.46;
    this._level += (rawLevel - this._level) * levelRate;
    if (rawLevel === 0 && this._level < 0.035) this._level = 0;
    const level = this._level;
    const rise = level - this._lastLevel;
    const now = performance.now();
    const hint = this._advanceHint(now, level, rise);

    if (level <= 0.02) {
      this._lastLevel = level;
      return this._decayToSilence(rms, hint);
    }

    this.analyser.getFloatFrequencyData(this.freq);
    const low = this._bandPower(100, 700);
    const openBand = this._bandPower(700, 1500);
    const frontBand = this._bandPower(1500, 3200);
    const high = this._bandPower(3200, 7600);
    const total = low + openBand + frontBand + high + 1e-12;
    const bass = low / total;
    const openness = openBand / total;
    const frontness = frontBand / total;
    const sibilance = high / total;

    const scores = {
      AA: smoothstep(0.16, 0.42, openness) * (0.62 + level * 0.38),
      EE: smoothstep(0.16, 0.42, frontness) * (1 - bass * 0.34),
      OO: smoothstep(0.30, 0.64, bass) * (1 - sibilance * 0.62),
      UW: smoothstep(0.42, 0.72, bass) * (0.95 - level * 0.24),
      FV: smoothstep(0.10, 0.34, sibilance) * (0.76 - level * 0.20),
      LTH: smoothstep(0.14, 0.36, frontness) * (1 - sibilance * 0.58) * 0.68,
      SZ: smoothstep(0.18, 0.52, sibilance),
      BMP: level < 0.16 && this._lastLevel > 0.34 ? 0.92 : 0,
    };

    if (hint !== 'neutral') {
      const consonant = ['BMP', 'FV', 'LTH', 'SZ'].includes(hint);
      const hintStrength = consonant ? 0.90 : 0.70;
      scores[hint] = Math.max(scores[hint], hintStrength);
    }

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    let pick = ranked[0][1] > 0.10 ? ranked[0][0] : 'AA';
    if (hint === 'BMP' && level < 0.24) pick = 'BMP';
    if (pick !== this._viseme && now - this._changedAt > 46) {
      this._viseme = pick;
      this._changedAt = now;
    }

    const targets = { ...EMPTY_WEIGHTS };
    const best = Math.max(0.001, ranked[0][1]);
    for (let i = 0; i < Math.min(2, ranked.length); i++) {
      const [name, score] = ranked[i];
      targets[name] = clamp01(score / best) * (i === 0 ? 1 : 0.34);
    }
    targets[this._viseme] = Math.max(targets[this._viseme], 0.72);
    for (const name of VISEMES) {
      const rate = targets[name] > this._weights[name] ? 0.48 : 0.38;
      this._weights[name] += (targets[name] - this._weights[name]) * rate;
    }

    this._ee += (this._weights.EE - this._ee) * 0.46;
    this._oo += (Math.max(this._weights.OO, this._weights.UW * 0.9) - this._oo) * 0.46;
    this._lastLevel = level;
    const sample = {
      level,
      rms,
      viseme: this._viseme,
      hint,
      queueDepth: this._hintQueue.length,
      speechActive: this._speechActive,
      ee: this._ee,
      oo: this._oo,
      weights: { ...this._weights },
    };
    this._lastSample = sample;
    return sample;
  }

  get diagnostics() {
    return { attached: Boolean(this.analyser), ...this._lastSample };
  }

  close() {
    this.detach();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}
