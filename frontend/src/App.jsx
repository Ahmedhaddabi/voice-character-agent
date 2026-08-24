import { useEffect, useMemo, useRef, useState } from 'react';
import CharacterStage from './components/CharacterStage';
import { CharacterController, GESTURES } from './lib/characterController';
import { useVoiceAgent } from './hooks/useVoiceAgent';
import { CHARACTER_NAME } from './persona';

const STATUS_COPY = {
  idle: 'Not connected',
  connecting: 'Connecting',
  live: 'Listening',
  error: 'Something broke',
};

export default function App() {
  const controller = useMemo(() => new CharacterController(), []);
  const { status, error, transcript, muted, connect, disconnect, toggleMute } = useVoiceAgent(controller);
  const [anim, setAnim] = useState({ speaking: false, emotion: 'neutral', gesture: null });
  const scrollRef = useRef(null);

  useEffect(() => controller.subscribe(setAnim), [controller]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript]);

  const live = status === 'live';
  const label = live && anim.speaking ? 'Speaking' : live && muted ? 'Muted' : STATUS_COPY[status];

  return (
    <div className="app">
      <header className="bar">
        <span className="bar__name">{CHARACTER_NAME}</span>
        <span className={`pill pill--${anim.speaking && live ? 'speaking' : status}`}>
          <i className="dot" />
          {label}
        </span>
      </header>

      <main className="main">
        <CharacterStage controller={controller} speaking={anim.speaking} />

        <aside className="side">
          <div className="side__log" ref={scrollRef}>
            {transcript.length === 0 ? (
              <p className="side__empty">
                {live ? `Say something — ${CHARACTER_NAME} is listening.` : 'Start the conversation to see the transcript.'}
              </p>
            ) : (
              transcript.map((line, i) => (
                <p key={i} className={`line line--${line.role}`}>
                  <span className="line__who">{line.role === 'user' ? 'You' : CHARACTER_NAME}</span>
                  {line.text}
                </p>
              ))
            )}
          </div>

          <div className="side__debug">
            <span className="side__label">Test a gesture</span>
            <div className="chips">
              {GESTURES.map((g) => (
                <button key={g} className="chip" onClick={() => controller.playGesture(g)}>
                  {g}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </main>

      {error && <p className="error">{error}</p>}

      <footer className="controls">
        {live ? (
          <>
            <button className="btn btn--ghost" onClick={toggleMute}>
              {muted ? 'Unmute microphone' : 'Mute microphone'}
            </button>
            <button className="btn btn--end" onClick={disconnect}>End conversation</button>
          </>
        ) : (
          <button className="btn btn--go" onClick={connect} disabled={status === 'connecting'}>
            {status === 'connecting' ? 'Connecting…' : `Talk to ${CHARACTER_NAME}`}
          </button>
        )}
      </footer>
    </div>
  );
}
