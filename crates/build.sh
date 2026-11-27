#!/bin/sh
# The kernel's build pipeline (WASM-001), run inside the builder image of Containerfile or on a
# machine that has the pinned toolchain (crates/rust-toolchain.toml), wasm-bindgen-cli 0.2.130 and
# wasm-opt (binaryen version_133). `packages/layout-kernel/scripts/build.ts` calls it.
#
#   build.sh test          native tests, formatting, clippy, the check for system libraries, and
#                          cargo-deny (advisories, licences, sources; needs the network)
#   build.sh build OUTDIR  cargo-deny, then wasm32-unknown-unknown, wasm-bindgen, wasm-opt; writes
#                          the package files
#   build.sh build-sea OUTDIR  the same for the module of Thai, Lao, Khmer and Burmese (WASM-016)
#
# Two builds of one commit give byte-identical files: the target directory is fresh or fixed, no
# path of the machine enters the output (remapped), no timestamp is written, and every tool is
# pinned. `packages/layout-kernel/scripts/build.ts --verify` builds twice and compares.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

export CARGO_INCREMENTAL=0
export SOURCE_DATE_EPOCH=0
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/docedit-kernel-target}"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
sysroot=$(rustc --print sysroot)
export RUSTFLAGS="-C debuginfo=0 --remap-path-prefix=$here=/crates --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$sysroot=/rustc"

# No crate of the kernel's tree links a system library: Cargo names those `*-sys`.
no_system_libraries() {
  tree=$(cargo tree --locked --target wasm32-unknown-unknown --prefix none --edges normal)
  if printf '%s\n' "$tree" | grep -E '(^|[ -])sys( |$)|-sys v' >/dev/null; then
    printf '%s\n' "$tree" | grep -E '-sys v' >&2 || true
    echo "the kernel depends on a system library (a -sys crate)" >&2
    exit 1
  fi
}

# The project's own crates forbid unsafe code (ADR 0016, decision 5): each inherits the workspace
# lint `unsafe_code = "forbid"` and repeats it as an attribute of its root file.
forbid_unsafe() {
  for manifest in */Cargo.toml; do
    crate=$(dirname "$manifest")
    if ! grep -q '^workspace = true' "$manifest"; then
      echo "$crate does not inherit the workspace lints" >&2
      exit 1
    fi
    if ! grep -q '^#!\[forbid(unsafe_code)\]' "$crate/src/lib.rs"; then
      echo "$crate/src/lib.rs does not forbid unsafe code" >&2
      exit 1
    fi
  done
}

# Advisories, licences, bans and sources of every dependency (WASM-013; owner decision 281), by
# cargo-deny with crates/deny.toml. A machine without cargo-deny fails here instead of skipping the
# check. The RustSec advisory database is fetched on each run: by cargo-deny itself when `git` is
# there, and otherwise (the builder image has no git) by `build.ts` on the host, which mounts the
# fresh clone at $CARGO_HOME/advisory-dbs. Then cargo-deny runs offline, which it only allows for a
# database fetched in the last 90 days, and the crates come from the registry that `cargo fetch`
# has just filled.
advisories() {
  if ! command -v cargo-deny >/dev/null 2>&1; then
    echo "cargo-deny is not installed: use the builder image (crates/Containerfile) or cargo install cargo-deny" >&2
    exit 1
  fi
  offline=""
  if ! command -v git >/dev/null 2>&1; then
    if [ ! -d "$cargo_home/advisory-dbs" ]; then
      echo "no git and no advisory database mounted at $cargo_home/advisory-dbs (build.ts fetches it)" >&2
      exit 1
    fi
    cargo fetch --locked
    offline="--offline"
  fi
  cargo deny --locked $offline --manifest-path "$here/Cargo.toml" --config "$here/deny.toml" check
}

case "${1:-}" in
  test)
    forbid_unsafe
    cargo fmt --all --check
    cargo clippy --locked --all-targets -- -D warnings
    cargo test --locked
    no_system_libraries
    advisories
    ;;
  build|build-sea)
    # `build` is the layout kernel. `build-sea` is the module of Thai, Lao, Khmer and Burmese
    # dictionaries (WASM-016), which a page fetches only when a document uses those scripts.
    if [ "$1" = build-sea ]; then
      crate=docedit-sea-segmenter
      stem=docedit_sea_segmenter
    else
      crate=docedit-layout-kernel
      stem=docedit_layout_kernel
    fi
    out="${2:?usage: build.sh build OUTDIR | build-sea OUTDIR}"
    no_system_libraries
    advisories
    cargo build --locked --release --target wasm32-unknown-unknown -p "$crate"
    raw="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/$stem.wasm"
    rm -rf "$out"
    mkdir -p "$out"
    # `web` gives an ES module with `initSync` and `init`, which Node.js and every browser load.
    wasm-bindgen --target web --typescript --out-dir "$out" --out-name $stem "$raw"
    # The features rustc 1.89 emits for wasm32-unknown-unknown, and no more. `--all-features` also
    # switches on newer encodings (compact imports) that Node.js 22 and the browsers do not read.
    wasm-opt -Oz --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int \
      --enable-bulk-memory --enable-reference-types --enable-multivalue \
      --strip-debug --strip-producers \
      -o "$out/${stem}_bg.wasm.opt" "$out/${stem}_bg.wasm"
    mv "$out/${stem}_bg.wasm.opt" "$out/${stem}_bg.wasm"
    # What was built, with no date and no path, so that the file is the same on every build.
    wasm_sha=$(sha256sum "$out/${stem}_bg.wasm" | cut -d' ' -f1)
    wasm_bytes=$(wc -c < "$out/${stem}_bg.wasm" | tr -d ' ')
    {
      printf '{\n'
      printf '  "crate": "%s",\n' "$crate"
      printf '  "crateVersion": "%s",\n' "$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)"
      printf '  "rustc": "%s",\n' "$(rustc --version)"
      printf '  "wasmBindgen": "%s",\n' "$(wasm-bindgen --version)"
      printf '  "wasmOpt": "%s",\n' "$(wasm-opt --version)"
      printf '  "wasm": { "file": "%s_bg.wasm", "bytes": %s, "sha256": "%s" }\n' "$stem" "$wasm_bytes" "$wasm_sha"
      printf '}\n'
    } > "$out/build.json"
    ;;
  *)
    echo "usage: build.sh test | build OUTDIR | build-sea OUTDIR" >&2
    exit 2
    ;;
esac
