"""Rewrite leftover image prefixes to public card_id. Used by rails sync."""
from __future__ import annotations

import re

IMAGE_KEYS = (
    "imageUrl",
    "image_url",
    "cdn_image_url",
    "previewImageUrl",
    "preview_image_url",
    "homepageImageUrl",
    "homepage_image_url",
    "gridImageUrl",
    "heroImageUrl",
    "tileImageUrl",
)

PREFIX_RE = re.compile(r"(^|/)(previews/)?(\d+)_")


def rewrite_public_card(card: dict) -> dict:
    out = {
        key: value
        for key, value in (card or {}).items()
        if key not in {"rn", "is_chase", "ct_id", "ctId"} and not str(key).startswith("_")
    }
    pokoin = str(out.get("card_id") or out.get("id") or "").strip()
    leftover = str((card or {}).get("ct_id") or (card or {}).get("ctId") or "").strip()
    if pokoin:
        out["id"] = pokoin
        out["card_id"] = pokoin
    if out.get("set_name") and not out.get("set"):
        out["set"] = out["set_name"]
    if pokoin:
        for key in IMAGE_KEYS:
            value = out.get(key)
            if not value:
                continue
            text = str(value)
            if leftover and leftover != pokoin:
                text = re.sub(
                    rf"(^|/)(previews/)?{re.escape(leftover)}_",
                    lambda match: f"{match.group(1)}{match.group(2) or ''}{pokoin}_",
                    text,
                )
            def _prefix(match: re.Match) -> str:
                if match.group(3) == pokoin:
                    return match.group(0)
                return f"{match.group(1)}{match.group(2) or ''}{pokoin}_"
            text = PREFIX_RE.sub(_prefix, text)
            out[key] = text
    return out
