// The one place animation state lives. The voice session writes to it,
// the renderer reads from it. Neither knows about the other.

export const EMOTIONS = ['neutral', 'happy', 'curious', 'thoughtful', 'surprised', 'sad'];
export const GESTURES = ['wave', 'nod', 'shrug', 'point', 'think', 'celebrate'];

const GESTURE_DURATION = { wave: 2.2, nod: 1.2, shrug: 1.6, point: 1.8, think: 2.6, celebrate: 2.0 };

export class CharacterController {
  constructor() {
    this.mouth = 0;
    this.emotion = 'neutral';
    this.gesture = null;
    this.gestureAge = 0;
    this.speaking = false;
    this.listening = false;
    this.blink = 0;
    this._nextBlink = 1.5 + Math.random() * 3;
    this._sinceGesture = 0;
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

  // Called by the lip sync loop every frame with a raw 0..1 amplitude.
  pushAmplitude(level, dt) {
    this.mouth += (level - this.mouth) * Math.min(1, dt * 22);

    const nowSpeaking = this.mouth > 0.06;
    if (nowSpeaking !== this.speaking) {
      this.speaking = nowSpeaking;
      this._emit();
      // Speech starting is a natural moment for an idle gesture, but only
      // if the model has not already asked for one recently.
      if (nowSpeaking && !this.gesture && this._sinceGesture > 6) {
        this.playGesture(Math.random() < 0.5 ? 'nod' : 'point');
      }
    }
  }

  // Cut everything short when the user barges in.
  interrupt() {
    this.mouth = 0;
    this.gesture = null;
    this._emit();
  }

  tick(dt) {
    this._sinceGesture += dt;

    if (this.gesture) {
      this.gestureAge += dt;
      if (this.gestureAge > (GESTURE_DURATION[this.gesture] ?? 1.5)) {
        this.gesture = null;
        this._emit();
      }
    }

    this._nextBlink -= dt;
    if (this._nextBlink <= 0) {
      this.blink = 1;
      this._nextBlink = 2 + Math.random() * 4;
    }
    this.blink = Math.max(0, this.blink - dt * 8);
  }

  // Normalised 0..1 progress through the current gesture.
  get gesturePhase() {
    if (!this.gesture) return 0;
    return Math.min(1, this.gestureAge / (GESTURE_DURATION[this.gesture] ?? 1.5));
  }
}
