// Derives a mouth-open value from the agent's outgoing audio.
//
// The realtime model sends audio, not phonemes, so lip sync has to come from
// the signal itself. RMS amplitude is crude but reads well on a stylised
// character. Swap read() for a formant-based viseme blend later without
// touching anything else.

// Silence is never truly silent: stream hiss and room tone sit a little above
// zero, and anything above this floor holds her mouth open. Raised from 0.012,
// which was low enough that she never fully closed between words.
const NOISE_FLOOR = 0.045;
const GAIN = 3.6;

export class LipSync {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buffer = null;
    this.source = null;
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
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.2;
    this.buffer = new Uint8Array(this.analyser.fftSize);
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

  // Returns 0..1. Call once per animation frame.
  read() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.buffer);

    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const v = (this.buffer[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.buffer.length);
    if (rms < NOISE_FLOOR) return 0;
    return Math.min(1, (rms - NOISE_FLOOR) * GAIN * 10);
  }

  close() {
    this.detach();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}
