#!/usr/bin/env bash
# sharp overlay for the Pi API release, both CPU architectures.
# The live release has sharp 0.34.5 with linux-arm64 binaries only, so the x64
# k3s pods cannot load sharp at all. Build one glibc overlay with the arm64 and
# x64 sharp + libvips binaries, semver nested under sharp so the release's
# top-level semver is never replaced.
#
#   scripts/build-sharp-overlay.sh <out-dir>
set -euo pipefail

SHARP_VERSION=0.35.5

[[ $# -eq 1 ]] || { echo "build-sharp-overlay: usage: $0 <out-dir>" >&2; exit 1; }
out="$1"
die() { echo "build-sharp-overlay: $*" >&2; exit 1; }

tmp="$(mktemp -d /tmp/pokoin-sharp-build-XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

install_for_cpu() {
  cpu="$1"
  dir="$tmp/$cpu"
  mkdir -p "$dir"
  printf '{"name":"v","version":"1.0.0"}\n' > "$dir/package.json"
  (cd "$dir" && npm install --silent --no-audit --no-fund --os=linux --libc=glibc --cpu="$cpu" "sharp@$SHARP_VERSION")
  printf '%s\n' "$dir"
}

pkg_dir() {
  dir="$1"
  pkg="$2"
  if [[ -d "$dir/node_modules/$pkg" ]]; then
    printf '%s\n' "$dir/node_modules/$pkg"
    return
  fi
  if [[ -d "$dir/node_modules/sharp/node_modules/$pkg" ]]; then
    printf '%s\n' "$dir/node_modules/sharp/node_modules/$pkg"
    return
  fi
  die "missing $pkg in $dir"
}

arm64="$(install_for_cpu arm64)"
x64="$(install_for_cpu x64)"

mkdir -p "$out/node_modules" "$out/node_modules/@img"
cp -a "$arm64/node_modules/sharp" "$out/node_modules/sharp"
mkdir -p "$out/node_modules/sharp/node_modules"
cp -a "$(pkg_dir "$arm64" semver)" "$out/node_modules/sharp/node_modules/semver"

for pkg in sharp-linux-arm64 sharp-libvips-linux-arm64; do
  [[ -d "$arm64/node_modules/@img/$pkg" ]] || die "missing @img/$pkg in the arm64 build"
  cp -a "$arm64/node_modules/@img/$pkg" "$out/node_modules/@img/$pkg"
done
for pkg in sharp-linux-x64 sharp-libvips-linux-x64; do
  [[ -d "$x64/node_modules/@img/$pkg" ]] || die "missing @img/$pkg in the x64 build"
  cp -a "$x64/node_modules/@img/$pkg" "$out/node_modules/@img/$pkg"
done

for banned in "@img/sharp-wasm32" "@emnapi" "tslib"; do
  if [[ -e "$out/node_modules/$banned" ]]; then
    die "overlay must not contain $banned"
  fi
done

version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$out/node_modules/sharp/package.json")"
[[ "$version" == "$SHARP_VERSION" ]] || die "sharp is $version, expected $SHARP_VERSION"

# Extra copy used only by the local x64 staging check on nezopt: the overlay
# plus the two runtime deps sharp loads outside @img/sharp-*.
check="$out/x64check/node_modules"
mkdir -p "$check"
cp -a "$out/node_modules/." "$check/"
cp -a "$(pkg_dir "$arm64" "@img/colour")" "$check/@img/colour"
cp -a "$(pkg_dir "$arm64" detect-libc)" "$check/detect-libc"

du -sh "$out"
