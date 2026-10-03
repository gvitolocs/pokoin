"""Deprecated: Valkey is retired. Use redis_cache (Pi Redis :6380)."""
from __future__ import annotations

from redis_cache import get_json, set_json  # noqa: F401

__all__ = ["get_json", "set_json"]
