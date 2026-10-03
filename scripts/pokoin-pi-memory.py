#!/usr/bin/env python3
"""One lightweight Pi memory sample. Appends a single JSON line.

Reads /proc. PSS is collected only for the largest RSS processes, not the
whole process table.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

LOG = Path(os.environ.get("POKOIN_PI_MEMORY_LOG", "/var/log/pokoin-pi-memory.jsonl"))
TOP_N = 12
PSS_N = 8
NAMES = (
    "current",
    "redis-server",
    "postgres",
    "cloudflared",
    "dockerd",
    "containerd",
    "node",
)


def meminfo() -> dict[str, int]:
    out = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, _, rest = line.partition(":")
        if key in {
            "MemTotal",
            "MemAvailable",
            "MemFree",
            "Cached",
            "Buffers",
            "SwapTotal",
            "SwapFree",
            "SwapCached",
            "AnonPages",
            "Dirty",
        }:
            out[key] = int(rest.strip().split()[0])
    return out


def vmstat_fields() -> dict[str, int]:
    wanted = {"pswpin", "pswpout", "pgmajfault"}
    out = {}
    for line in Path("/proc/vmstat").read_text().splitlines():
        key, _, value = line.partition(" ")
        if key in wanted:
            out[key] = int(value)
    return out


def rollup(pid: int) -> tuple[int, int]:
    try:
        text = Path(f"/proc/{pid}/smaps_rollup").read_text()
    except OSError:
        return 0, 0
    pss = swap = 0
    for line in text.splitlines():
        if line.startswith("Pss:"):
            pss = int(line.split()[1])
        elif line.startswith("Swap:"):
            swap = int(line.split()[1])
    return pss, swap


def processes() -> list[dict]:
    rows = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            comm = (entry / "comm").read_text().strip()
            rss_pages = 0
            for line in (entry / "status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    rss_pages = int(line.split()[1])
                    break
        except OSError:
            continue
        if rss_pages < 1024 and comm not in NAMES:
            continue
        cmd = ""
        try:
            raw = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
            cmd = " ".join(raw.split())[:180]
        except OSError:
            cmd = comm
        rows.append({"pid": pid, "comm": comm, "rss_kb": rss_pages, "cmd": cmd})
    rows.sort(key=lambda row: row["rss_kb"], reverse=True)
    interesting = []
    seen = set()
    for row in rows:
        if row["pid"] in seen:
            continue
        keep = row in rows[:TOP_N] or any(token in row["cmd"] or token == row["comm"] for token in NAMES)
        if not keep:
            continue
        seen.add(row["pid"])
        interesting.append(row)
        if len(interesting) >= TOP_N + 6:
            break
    for index, row in enumerate(interesting):
        if index < PSS_N or row["rss_kb"] >= 50 * 1024:
            pss, swap = rollup(row["pid"])
            row["pss_kb"] = pss
            row["swap_kb"] = swap
    return interesting


def containers() -> list[dict]:
    roots = (
        Path("/sys/fs/cgroup/system.slice"),
        Path("/sys/fs/cgroup"),
    )
    found = []
    seen = set()
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.glob("docker-*.scope/memory.current"):
            if path in seen:
                continue
            seen.add(path)
            try:
                current = int(path.read_text().strip())
            except OSError:
                continue
            if current < 20 * 1024 * 1024:
                continue
            found.append({
                "cgroup": path.parent.name[-80:],
                "current_mb": round(current / 1048576, 1),
            })
        if found:
            break
    found.sort(key=lambda row: row["current_mb"], reverse=True)
    return found[:12]


def main() -> None:
    info = meminfo()
    vm_a = vmstat_fields()
    time.sleep(1)
    vm_b = vmstat_fields()
    sample = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mem_available_mb": round(info.get("MemAvailable", 0) / 1024, 1),
        "anon_mb": round(info.get("AnonPages", 0) / 1024, 1),
        "cache_mb": round((info.get("Cached", 0) + info.get("Buffers", 0)) / 1024, 1),
        "swap_used_mb": round((info.get("SwapTotal", 0) - info.get("SwapFree", 0)) / 1024, 1),
        "swap_cached_mb": round(info.get("SwapCached", 0) / 1024, 1),
        "pswpin": vm_b.get("pswpin", 0) - vm_a.get("pswpin", 0),
        "pswpout": vm_b.get("pswpout", 0) - vm_a.get("pswpout", 0),
        "pgmajfault": vm_b.get("pgmajfault", 0) - vm_a.get("pgmajfault", 0),
        "processes": processes(),
        "cgroups": containers(),
    }
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(sample, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
