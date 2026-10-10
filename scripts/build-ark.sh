#!/bin/sh
# Builds the Ark engine (kilombino-arkd, from the Kilombino/paperclip-wallet-app fork, branch
# kilombino-esplora) for both StartOS architectures and puts it where the Dockerfile takes it:
# ark-bin/amd64 and ark-bin/arm64. Needs Rust (with the aarch64-unknown-linux-gnu target),
# protoc, clang, and gcc-aarch64-linux-gnu + libc6-dev-arm64-cross for the arm64 build.
#   PAPERCLIP=~/Projects/blake2b/paperclip-wallet scripts/build-ark.sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
src=${PAPERCLIP:-$HOME/Projects/blake2b/paperclip-wallet}
cd "$src"
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
# Gentle on a machine that does other work: lowest CPU and I/O priority.
run() { nice -n 19 ionice -c3 "$@"; }
run cargo build --locked --profile android -p kilombino-ark --bin kilombino-arkd
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar \
BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_gnu="--sysroot=/usr/aarch64-linux-gnu" \
  run cargo build --locked --profile android --target aarch64-unknown-linux-gnu -p kilombino-ark --bin kilombino-arkd
mkdir -p "$here/ark-bin/amd64" "$here/ark-bin/arm64"
cp target/android/kilombino-arkd "$here/ark-bin/amd64/"
cp target/aarch64-unknown-linux-gnu/android/kilombino-arkd "$here/ark-bin/arm64/"
echo "engine at $(git rev-parse --short HEAD):"; sha256sum "$here"/ark-bin/*/kilombino-arkd
