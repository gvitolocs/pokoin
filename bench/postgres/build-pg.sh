#!/usr/bin/env bash
# Build one Postgres release from the GitHub mirror into <out>/inst<label>,
# with the options the official Docker images use (ICU, OpenSSL, LZ4, zstd)
# and contrib (pg_trgm, unaccent, pgcrypto, pg_stat_statements).
#
#   bench/postgres/build-pg.sh REL_17_11 17 "$OUT"
#   bench/postgres/build-pg.sh REL_19_BETA4 19 "$OUT"
#
# Needs: gcc, make, bison, flex, pkg-config and the libicu, libssl, liblz4,
# libzstd, libreadline, zlib headers (Debian/Ubuntu: apt-get install flex
# libicu-dev libssl-dev liblz4-dev libzstd-dev libreadline-dev zlib1g-dev).
set -euo pipefail
tag=${1:?tag, e.g. REL_17_11} label=${2:?label, e.g. 17} out=${3:?output dir}
src=$out/src$label inst=$out/inst$label
mkdir -p "$out"
[[ -d $src/.git ]] || git clone -q --depth 1 --branch "$tag" https://github.com/postgres/postgres "$src"
cd "$src"
./configure -q --prefix="$inst" --with-icu --with-openssl --with-lz4 --with-zstd --with-readline CFLAGS=-O2 >/dev/null
make -s -j"$(nproc)" world-bin >/dev/null
make -s install-world-bin >/dev/null
"$inst/bin/postgres" --version
