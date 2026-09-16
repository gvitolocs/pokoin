"""OpenAI-compatible llama.cpp client for Qwen on nezopt.

Do not call Ollama (:11434). Text Qwen 3.8 27B is llama-server behind the
:11436 proxy (origin :11438). Chat needs `~/.config/llama-server-api.key`
or `LLAMA_API_KEY`. `/v1/models` is a static list and does not load VRAM.
Vision leftover jobs need a llama.cpp mmproj server on the same API.
"""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

LLAMA_BASE = os.environ.get("LLAMA_SERVER", "http://127.0.0.1:11436").rstrip("/")
DEFAULT_MODEL = os.environ.get("QWEN_LLAMA_MODEL", "qwen3.8:27b-128k")
_KEY_FILE = Path(os.environ.get("LLAMA_SERVER_API_KEY_FILE", os.path.expanduser("~/.config/llama-server-api.key")))


def _auth_headers():
    headers = {"Content-Type": "application/json"}
    key = os.environ.get("LLAMA_API_KEY", "").strip()
    if not key and _KEY_FILE.is_file():
        key = _KEY_FILE.read_text().strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def chat(messages, *, model=DEFAULT_MODEL, temperature=0, max_tokens=160, timeout=180):
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        f"{LLAMA_BASE}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers=_auth_headers(),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read())
    return ((body.get("choices") or [{}])[0].get("message") or {}).get("content") or ""


def chat_image(prompt: str, image_bytes: bytes, *, mime="image/jpeg", **kwargs):
    import base64
    b64 = base64.b64encode(image_bytes).decode()
    return chat(
        [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        }],
        **kwargs,
    )
