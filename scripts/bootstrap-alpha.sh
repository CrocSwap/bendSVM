#!/usr/bin/env bash
set -euo pipefail

# Safe bootstrap for the experimental alpha. It only creates/updates the
# explicitly scoped .deps/bend checkout, Cargo/npm caches and the hash-checked
# ~/.cache/solana/v1.57 platform-tools; it does not touch the user's wallet,
# Solana CLI config, or any source/build directory.
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
export BEND_NO_TELEMETRY=1
BEND_COMMIT=7561656155a4285c1e4ccfcb3505ab59524de973

command -v git >/dev/null || { echo 'missing git' >&2; exit 1; }
command -v npm >/dev/null || { echo 'missing npm' >&2; exit 1; }
command -v cargo >/dev/null || { echo 'missing cargo' >&2; exit 1; }

npm ci

if [ ! -d .deps/bend/.git ]; then
  mkdir -p .deps/bend
  git -C .deps/bend init -q
  git -C .deps/bend remote add origin https://github.com/bendlang/bend.git
  git -C .deps/bend fetch -q --depth=1 origin "$BEND_COMMIT"
  git -C .deps/bend checkout -q --detach FETCH_HEAD
else
  current="$(git -C .deps/bend rev-parse HEAD 2>/dev/null || true)"
  dirty="$(git -C .deps/bend status --porcelain 2>/dev/null || true)"
  if [ "$current" != "$BEND_COMMIT" ] || [ -n "$dirty" ]; then
    echo ".deps/bend exists but is not clean at $BEND_COMMIT; inspect it and retry" >&2
    exit 1
  fi
fi

cargo fetch --locked --manifest-path Cargo.toml
cargo fetch --locked --manifest-path scripts/test-runner/Cargo.toml
cargo fetch --locked --manifest-path scripts/test-runner-modern/Cargo.toml
cargo fetch --locked --manifest-path tests-modern/Cargo.toml
cargo fetch --locked --manifest-path scripts/modern-library-runner/Cargo.toml
cargo fetch --locked --manifest-path scripts/local-runner/Cargo.toml
cargo fetch --locked --manifest-path scripts/live-queue/Cargo.toml
# Solana (SBPFv3) toolchain: hash-checked install into ~/.cache/solana/v1.57
# (or verify an existing one). BEND_SKIP_PLATFORM_TOOLS=1 skips it for
# Fogo-only use; SBF_V157_TOOLS points at a toolchain installed elsewhere.
if [ "${BEND_SKIP_PLATFORM_TOOLS:-}" != 1 ] && [ -z "${SBF_V157_TOOLS:-}" ]; then
  npm run -s install:platform-tools
fi
npm run doctor -- --write build/alpha-doctor.json
echo 'External-alpha bootstrap complete. Review the doctor output before building.'
