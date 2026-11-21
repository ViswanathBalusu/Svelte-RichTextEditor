#!/bin/sh
# Runs the visual-regression specs of packages/ui inside the Playwright container (CI job "visual").
#
# The Linux baselines of ux-064-rtl-visual.spec.ts-snapshots were recorded in the Playwright
# v1.65.0 container (docs/adr/0329-lane-V-UX-061-075.md, round 5, item 2): pixels depend on the
# fonts of the machine, and the fonts of a hosted runner are not those of the container. The spec
# skips on Linux unless DOCEDIT_PLAYWRIGHT_CONTAINER=1, which this script sets.
#
# Usage (from the repository root, the image is pinned by digest in .github/workflows/ci.yml):
#   podman run --rm --ipc=host -v "$PWD:/work" -w /work <image> sh scripts/ci/visual-in-container.sh
# To record new baselines, add `--update-snapshots` after the script name: the arguments go to
# `playwright test`. Rootless Podman on a machine without the `pids` cgroup controller needs
# `--pids-limit=0` as well.
set -eu

# The image has Node.js and the browsers, and no pnpm. The version is the one of package.json.
pnpm_version="$(node -e "console.log(require('./package.json').packageManager.split('@')[1])")"
npm install --global --no-fund --no-audit "pnpm@${pnpm_version}"
pnpm install --frozen-lockfile

export CI=1
export DOCEDIT_PLAYWRIGHT_CONTAINER=1
export DOCEDIT_BROWSERS=chromium,firefox,webkit
exec pnpm exec playwright test -c packages/ui/playwright.config.ts ux-064-rtl-visual "$@"
