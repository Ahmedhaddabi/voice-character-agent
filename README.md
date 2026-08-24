# Voice character agent

A speech-to-speech agent with an animated character on screen. Her mouth moves
from the audio signal; her hands and expression are driven by the model itself
through function calls.

Runs today with a placeholder figure so you can hear and see the whole loop
before your VRM is ready. Drop a `.vrm` in and it takes over.

## Setup

Backend:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # add your OpenAI key
uvicorn main:app --reload --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173, click "Talk to Tazima", allow the microphone.

Use headphones. Without them her own voice loops back into the mic and she
will interrupt herself constantly.

## How it fits together

| File | Job |
|---|---|
| `backend/main.py` | Mints ephemeral tokens. Your API key never reaches the browser. |
| `src/persona.js` | Who she is. The only file you edit to change her character. |
| `src/hooks/useVoiceAgent.js` | Session lifecycle, the two animation tools, transcript. |
| `src/lib/lipSync.js` | RMS amplitude from the output audio → mouth value. |
| `src/lib/characterController.js` | Single source of animation state. |
| `src/lib/stage.js` | Three.js renderer. VRM if loaded, placeholder otherwise. |

Audio goes browser ↔ OpenAI over WebRTC directly. The backend is only
consulted once, at connect, for the token.

## Adding your character

Export a VRM with humanoid bones and, ideally, the standard viseme
expressions (`aa`, `ih`, `ou`, `ee`, `oh`) plus `blink`. Name it
`character.vrm`, put it in `frontend/public/`, reload.

If your model has bones but no blendshapes yet, it still loads — arms, head
and gestures work, only the mouth stays still. Rotating a jaw bone by
`controller.mouth` in `applyToVRM` is a decent stopgap until you build the
shape keys.

## Tuning

`GAIN` and `NOISE_FLOOR` in `lipSync.js` control how wide her mouth opens.
The smoothing factor in `pushAmplitude` (currently `dt * 22`) is what
separates believable speech from a chattering jaw — adjust that first if the
lip sync looks wrong.

Gesture shapes live in `POSES` in `stage.js` as bone rotation offsets. They
apply to both the placeholder and a real rig, so you can tune them now and
they carry over.

If she never gestures, the fix is almost always in `persona.js` — the model
needs to be told explicitly and repeatedly to use the tools.

## Deploying to Render

This repo includes a `render.yaml` blueprint that provisions both services:

1. Push this repo to GitHub.
2. On [Render](https://dashboard.render.com), click **New +** → **Blueprint**, and point it at the repo.
3. Render creates two services: `voice-agent-backend` (FastAPI) and `voice-agent-frontend` (static Vite build).
4. Set `OPENAI_API_KEY` on the backend service (Render dashboard → service → Environment).
5. Once both services have URLs, set:
   - `ALLOWED_ORIGINS` on the backend to the frontend's URL (e.g. `https://voice-agent-frontend.onrender.com`)
   - `VITE_API_BASE` on the frontend to the backend's URL (e.g. `https://voice-agent-backend.onrender.com`), then trigger a redeploy of the frontend (static builds bake env vars in at build time)

## Known caveats

The package versions in `package.json` are current as of writing; check
`@openai/agents-realtime` release notes if the session API has moved.

Pin a current `gpt-realtime` snapshot in `backend/.env`. OpenAI flagged
legacy realtime model snapshots for removal on 20 January 2027.
