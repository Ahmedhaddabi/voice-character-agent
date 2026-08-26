import { useEffect, useRef, useState } from 'react';
import { Stage } from '../lib/stage';

const RIG_NOTE = {
  placeholder: 'Placeholder figure — drop a .glb or .vrm here to use your character',
  static: 'Your model is loaded but has no skeleton, so only breathing and sway are active',
  rigged: null,
  vrm: null,
};

export default function CharacterStage({ controller, speaking }) {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const [rig, setRig] = useState('placeholder');
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    const stage = new Stage(canvasRef.current, controller);
    stageRef.current = stage;

    // Whatever sits in public/ loads on open. A rigged VRM wins if both exist.
    (async () => {
      for (const url of ['/character.vrm', '/character.glb']) {
        try {
          setRig(await stage.loadModel(url));
          return;
        } catch { /* try the next one */ }
      }
    })();

    return () => stage.dispose();
  }, [controller]);

  const loadFile = async (file) => {
    if (!file || !/\.(vrm|glb)$/i.test(file.name)) {
      setLoadError('That needs to be a .glb or .vrm file.');
      return;
    }
    setLoadError(null);
    const url = URL.createObjectURL(file);
    try {
      setRig(await stageRef.current.loadModel(url));
    } catch (err) {
      setLoadError(err.message);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const note = loadError ?? RIG_NOTE[rig];

  return (
    <div
      className={`stage ${dragging ? 'stage--drop' : ''} ${speaking ? 'stage--speaking' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        loadFile(e.dataTransfer.files?.[0]);
      }}
    >
      <canvas ref={canvasRef} className="stage__canvas" />
      {note && <p className="stage__hint">{note}</p>}
    </div>
  );
}
