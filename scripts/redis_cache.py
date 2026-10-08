"""Tiny RESP client for marketplace Redis cache. Misses and downtime are non-fatal."""
from __future__ import annotations

import json
import os
import socket

REDIS_HOST = os.environ.get("REDIS_HOST") or "127.0.0.1"
REDIS_PORT = int(
    os.environ.get("REDIS_PORT")
    or os.environ.get("POKOIN_REDIS_PORT")
    or "6380"
)


def _encode(parts: list) -> bytes:
    chunks = [f"*{len(parts)}\r\n".encode()]
    for part in parts:
        data = part if isinstance(part, bytes) else str(part).encode()
        chunks.append(f"${len(data)}\r\n".encode() + data + b"\r\n")
    return b"".join(chunks)


def _read_reply(sock: socket.socket):
    buf = b""
    while b"\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            return None
        buf += chunk
    kind = buf[:1]
    rest, buf = buf.split(b"\r\n", 1)
    if kind == b"+":
        return rest[1:].decode()
    if kind == b"-":
        return None
    if kind == b":":
        return int(rest[1:])
    if kind == b"$":
        size = int(rest[1:])
        if size < 0:
            return None
        while len(buf) < size + 2:
            chunk = sock.recv(4096)
            if not chunk:
                return None
            buf += chunk
        return buf[:size].decode()
    return None


def _command(*parts, timeout: float = 0.25):
    try:
        with socket.create_connection((REDIS_HOST, REDIS_PORT), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(_encode(list(parts)))
            return _read_reply(sock)
    except OSError:
        return None


def get_json(key: str):
    raw = _command("GET", key)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def set_json(key: str, value, ttl_seconds: int) -> bool:
    if value is None or ttl_seconds <= 0:
        return False
    try:
        payload = json.dumps(value, separators=(",", ":"))
    except (TypeError, ValueError):
        return False
    return _command("SETEX", key, int(ttl_seconds), payload) == "OK"
