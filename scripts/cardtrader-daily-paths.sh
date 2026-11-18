#!/usr/bin/env bash
# shellcheck disable=SC2034 # Variables are consumed by the sourcing scripts.
# Shared local runtime defaults. Sourced by the runner and read-only preflight.
AI_PYTHON="${POKOIN_AI_PYTHON:-/home/nez/Projects/AI/ai-toolkit/venv/bin/python}"
GPU_LEASE_BIN="${POKOIN_GPU_LEASE:-/home/nez/bin/gpu-lease}"
DUMP_BIN="${POKOIN_CT_DUMP_BIN:-/home/nez/services/pokoin-cardtrader/current/pokoin-cardtrader-listing-dump}"
PRICE_BIN="${POKOIN_CT_PRICE_BIN:-/home/nez/services/pokoin-cardtrader/current/pokoin-cardtrader-price-cache}"
SOLD_BIN="${POKOIN_CT_SOLD_BIN:-/home/nez/services/pokoin-cardtrader/current/pokoin-cardtrader-sold}"
CARD_REFRESH_BIN="${POKOIN_CARD_REFRESH_BIN:-/home/nez/.local/lib/card-refresh/current/daily-card-refresh.sh}"
