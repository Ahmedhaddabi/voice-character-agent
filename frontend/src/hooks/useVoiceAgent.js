import { useCallback, useEffect, useRef, useState } from 'react';
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC, tool } from '@openai/agents-realtime';
import { z } from 'zod';
import { PERSONA, CHARACTER_NAME } from '../persona';
import { EMOTIONS, GESTURES } from '../lib/characterController';
import { LipSync } from '../lib/lipSync';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000';

export function useVoiceAgent(controller) {
  const [status, setStatus] = useState('idle'); // idle | connecting | live | error
  const [error, setError] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [muted, setMuted] = useState(false);

  const sessionRef = useRef(null);
  const audioElRef = useRef(null);
  const lipSyncRef = useRef(null);
  const rafRef = useRef(null);

  // The animation tools run entirely in the browser. Nothing round-trips to a
  // server, so the character reacts the moment the model decides to move.
  const buildTools = useCallback(() => [
    tool({
      name: 'set_emotion',
      description: 'Change your facial expression to match how you feel right now.',
      parameters: z.object({ emotion: z.enum(EMOTIONS) }),
      execute: async ({ emotion }) => {
        controller.setEmotion(emotion);
        return `expression is now ${emotion}`;
      },
    }),
    tool({
      name: 'play_gesture',
      description: 'Perform a body gesture while you speak. Use often.',
      parameters: z.object({ gesture: z.enum(GESTURES) }),
      execute: async ({ gesture }) => {
        controller.playGesture(gesture);
        return `played ${gesture}`;
      },
    }),
  ], [controller]);

  const startLoop = useCallback(() => {
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // The remote stream appears on the audio element shortly after connect.
      const lip = lipSyncRef.current;
      const el = audioElRef.current;
      if (lip && el?.srcObject && !lip.analyser) lip.attach(el.srcObject);

      controller.pushAmplitude(lip ? lip.read() : 0, dt);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [controller]);

  const connect = useCallback(async () => {
    if (sessionRef.current) return;
    setStatus('connecting');
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/session`, { method: 'POST' });
      if (!res.ok) throw new Error(`Token service returned ${res.status}. Is the backend running?`);
      const { client_secret: clientSecret, model } = await res.json();

      // We own the audio element so the analyser has something to tap, and so
      // the stream keeps flowing in Chrome.
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      audioElRef.current = audioEl;

      const agent = new RealtimeAgent({
        name: CHARACTER_NAME,
        instructions: PERSONA,
        tools: buildTools(),
      });

      const session = new RealtimeSession(agent, {
        model,
        transport: new OpenAIRealtimeWebRTC({ audioElement: audioEl }),
        config: {
          audio: {
            input: { turnDetection: { type: 'semantic_vad', eagerness: 'medium' } },
          },
        },
      });

      session.on('audio_interrupted', () => controller.interrupt());
      session.on('error', (e) => setError(e?.error?.message ?? 'The session hit an error.'));
      session.on('history_updated', (history) => {
        setTranscript(
          history
            .filter((item) => item.type === 'message')
            .slice(-12)
            .map((item) => ({
              role: item.role,
              text: (item.content ?? [])
                .map((part) => part.transcript ?? part.text ?? '')
                .join(' ')
                .trim(),
            }))
            .filter((line) => line.text),
        );
      });

      await session.connect({ apiKey: clientSecret });

      sessionRef.current = session;
      lipSyncRef.current = new LipSync();
      controller.setListening(true);
      setStatus('live');
      startLoop();
    } catch (err) {
      setError(err.message ?? String(err));
      setStatus('error');
    }
  }, [buildTools, controller, startLoop]);

  const disconnect = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    lipSyncRef.current?.close();
    lipSyncRef.current = null;
    audioElRef.current?.remove();
    audioElRef.current = null;
    controller.interrupt();
    controller.setListening(false);
    setStatus('idle');
    setTranscript([]);
  }, [controller]);

  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const next = !muted;
    session.mute(next);
    setMuted(next);
    controller.setListening(!next);
  }, [muted, controller]);

  useEffect(() => () => disconnect(), [disconnect]);

  return { status, error, transcript, muted, connect, disconnect, toggleMute };
}
