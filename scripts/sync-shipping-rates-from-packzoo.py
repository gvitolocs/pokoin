#!/usr/bin/env python3
"""Deprecated entrypoint — use sync-shipping-rates.py (PackZoo + porto-data)."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name("sync-shipping-rates.py")), run_name="__main__")
