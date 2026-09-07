// The one place animation state lives. The voice session writes to it,
// the renderer reads from it. Neither knows about the other.

export const EMOTIONS = ['neutral', 'happy', 'curious', 'thoughtful', 'surprised', 'sad'];
export const GESTURES = ['wave', 'nod', 'point', 'celebrate'];

const GESTURE_DURATION = { wave: 1.8, nod: 0.9, point: 1.35, celebrate: 1.55 };
const SPEECH_PULSE_DURATION = 0.34;
const BLINK_DURATION = 0.18;

function smooth01(value) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export class CharacterController {
  constructor() {
    this.mouth = 0;
    this.viseme = 'neutral';
    this.visemeEE = 0;
    this.visemeOO = 0;
    this.emotion = 'neutral';
    this.gesture = null;
    this.gestureAge = 0;
    this.speaking = false;
    this.listening = false;
    this.blink = 0;
    this._blinkAge = Infinity;
    this._nextBlink = 1.5 + Math.random() * 3;
    this._sinceGesture = 0;
    this.speechEnergy = 0;
    this.speechPulse = 0;
    this._speechPulseAge = Infinity;
    this.speechSide = 1;
    this.speechMode = 0;
    this._speechAge = 0;
    this._speechHangover = 0;
    this._beatCooldown = 0;
    this._lastRawLevel = 0;
    this._phraseCount = 0;
    this._listeners = new Set();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const snapshot = { emotion: this.emotion, gesture: this.gesture, speaking: this.speaking, listening: this.listening };
    for (const fn of this._listeners) fn(snapshot);
  }

  setEmotion(emotion) {
    if (!EMOTIONS.includes(emotion)) return;
    this.emotion = emotion;
    this._emit();
  }

  playGesture(name) {
    if (!GESTURES.includes(name)) return;
    this.gesture = name;
    this.gestureAge = 0;
    this._sinceGesture = 0;
    this._emit();
  }

  setListening(value) {
    if (this.listening === value) return;
    this.listening = value;
    this._emit();
  }

  // Called once per animation frame. Besides mouth amplitude, the sample may
  // contain continuous EE/OO weights estimated from the outgoing audio.
  // Strong rising syllables also create short presentation beats, so hand and
  // head emphasis lands on speech instead of wandering on a timer.
  pushAmplitude(sample, dt) {
    const data = typeof sample === 'number' ? { level: sample } : (sample ?? {});
    const level = Math.max(0, Math.min(1, Number(data.level) || 0));
    const attack = level > this.mouth ? 30 : 38;
    this.mouth += (level - this.mouth) * (1 - Math.exp(-Math.max(0.001, dt) * attack));
    this.speechEnergy += (level - this.speechEnergy) * (1 - Math.exp(-Math.max(0.001, dt) * 10));

    this.viseme = data.viseme ?? (level > 0.04 ? 'AA' : 'neutral');
    const ee = Math.max(0, Math.min(1, Number(data.ee) || 0));
    const oo = Math.max(0, Math.min(1, Number(data.oo) || 0));
    const visemeAlpha = 1 - Math.exp(-Math.max(0.001, dt) * 24);
    this.visemeEE += (ee - this.visemeEE) * visemeAlpha;
    this.visemeOO += (oo - this.visemeOO) * visemeAlpha;

    if (level > 0.075) this._speechHangover = 0.12;
    else this._speechHangover = Math.max(0, this._speechHangover - dt);
    const nowSpeaking = this._speechHangover > 0 || this.mouth > 0.055;
    if (nowSpeaking !== this.speaking) {
      this.speaking = nowSpeaking;
      if (nowSpeaking) {
        this._speechAge = 0;
        this._phraseCount += 1;
        this.speechMode = (this._phraseCount - 1) % 3;
      }
      this._emit();
    }

    this._beatCooldown = Math.max(0, this._beatCooldown - dt);
    const rise = level - this._lastRawLevel;
    if (nowSpeaking && level > 0.16 && rise > 0.045 && this._beatCooldown <= 0) {
      this._speechPulseAge = 0;
      this.speechSide *= -1;
      this._beatCooldown = 0.24;
    }
    this._lastRawLevel = level;
  }

  // Cut everything short when the user barges in.
  interrupt() {
    this.mouth = 0;
    this.viseme = 'neutral';
    this.visemeEE = 0;
    this.visemeOO = 0;
    this.speechEnergy = 0;
    this.speechPulse = 0;
    this._speechPulseAge = Infinity;
    this._speechHangover = 0;
    this.gesture = null;
    this._emit();
  }

  tick(dt) {
    this._sinceGesture += dt;
    if (this.speaking) this._speechAge += dt;
    if (Number.isFinite(this._speechPulseAge)) {
      this._speechPulseAge += dt;
      const p = this._speechPulseAge / SPEECH_PULSE_DURATION;
      if (p >= 1) {
        this.speechPulse = 0;
        this._speechPulseAge = Infinity;
      } else if (p < 0.24) {
        this.speechPulse = smooth01(p / 0.24);
      } else {
        this.speechPulse = 1 - smooth01((p - 0.24) / 0.76);
      }
    }

    if (this.gesture) {
      this.gestureAge += dt;
      if (this.gestureAge > (GESTURE_DURATION[this.gesture] ?? 1.5)) {
        this.gesture = null;
        this._emit();
      }
    }

    this._nextBlink -= dt;
    if (this._nextBlink <= 0) {
      this._blinkAge = 0;
      this._nextBlink = 2 + Math.random() * 4;
    }
    if (Number.isFinite(this._blinkAge)) {
      this._blinkAge += dt;
      const p = this._blinkAge / BLINK_DURATION;
      if (p >= 1) {
        this.blink = 0;
        this._blinkAge = Infinity;
      } else if (p < 0.38) {
        this.blink = smooth01(p / 0.38);
      } else {
        this.blink = 1 - smooth01((p - 0.38) / 0.62);
      }
    }
  }

  // Normalised 0..1 progress through the current gesture.
  get gesturePhase() {
    if (!this.gesture) return 0;
    return Math.min(1, this.gestureAge / (GESTURE_DURATION[this.gesture] ?? 1.5));
  }

  get speechAge() {
    return this._speechAge;
  }
}
