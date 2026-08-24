"""Token service for the voice character agent.

The browser never sees your real OpenAI key. It asks this service for a
short-lived client secret, then opens the WebRTC connection to OpenAI
directly — audio never passes through here, which is what keeps latency low.
"""

import os

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gpt-realtime-2.1")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")

app = FastAPI(title="Voice character agent — token service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"ok": True, "model": REALTIME_MODEL, "key_loaded": bool(OPENAI_API_KEY)}


@app.post("/api/session")
async def create_session():
    """Mint an ephemeral client secret for one browser session."""
    if not OPENAI_API_KEY:
        raise HTTPException(500, "OPENAI_API_KEY is not set. Copy .env.example to .env.")

    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            "https://api.openai.com/v1/realtime/client_secrets",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"session": {"type": "realtime", "model": REALTIME_MODEL}},
        )

    if response.status_code >= 400:
        raise HTTPException(response.status_code, f"OpenAI rejected the request: {response.text}")

    payload = response.json()
    secret = payload.get("value") or payload.get("client_secret", {}).get("value")
    if not secret:
        raise HTTPException(502, "No client secret in the OpenAI response.")

    return {"client_secret": secret, "model": REALTIME_MODEL}
