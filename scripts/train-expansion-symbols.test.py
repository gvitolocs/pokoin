#!/usr/bin/env python3
"""Compatibility entry point; active tool moved to pokoin-scanner."""
import os
import runpy
from pathlib import Path
root = Path(os.environ.get("POKOIN_SCANNER_REPO", "/home/nez/Projects/pokoin-scanner"))
runpy.run_path(str(root / "training/symbols/train-expansion-symbols.test.py"), run_name="__main__")
