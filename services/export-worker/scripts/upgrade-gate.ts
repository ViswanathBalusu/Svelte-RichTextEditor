/**
 * The upgrade gate of the export worker image (SEC-053 criterion 4; EXP-078; 09 §9.4):
 *
 *   node services/export-worker/scripts/upgrade-gate.ts [--image <tag>]
 *
 * A TeX Live upgrade, a change of the curated package list or a change of the class is proposed as
 * a candidate image. Before it is rolled out, this runs three things against that image and fails
 * if any of them does:
 *
 *   1. the engine ledger (`src/exp-078-engine-ledger.test.ts`): the base image of the Containerfile
 *      must be the last entry of `image/engine-releases.json`, and an entry must come with a new
 *      house class release, so an upgrade is a class version change;
 *   2. the reference comparison of the corpus (`src/exp-078-reference.podman.test.ts`): a fresh
 *      compile of each document with a stored reference PDF in the candidate image must have no
 *      moved line and no moved page break;
 *   3. the comparison of the shared references of EXP-114 by text position and by pixels
 *      (`packages/export-latex/src/exp-114-compare.compile.test.ts`).
 *
 * The candidate is built first (`scripts/build-image.ts`, with DOCEDIT_EXPORT_IMAGE set to its tag).
 * The previous image stays where it is until the rollout is complete; this script changes nothing.
 * The sandbox must be ready (DOCEDIT_REQUIRE_SANDBOX=1 is set, so a skipped test is a failure). On
 * a Windows or macOS host set DOCEDIT_PODMAN_MACHINE, and DOCEDIT_CONTAINER_CGROUPS=disabled where
 * the machine has no cgroup controllers, as for every Podman test of the worker.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const at = argv.indexOf('--image');
const image = at >= 0 ? argv[at + 1] : process.env['DOCEDIT_EXPORT_IMAGE'];
if (!image) {
  console.error('usage: node services/export-worker/scripts/upgrade-gate.ts --image <tag>');
  process.exit(2);
}

const GATE_TESTS: readonly string[] = [
  'services/export-worker/src/exp-078-engine-ledger.test.ts',
  'services/export-worker/src/exp-078-reference.podman.test.ts',
  'packages/export-latex/src/exp-114-compare.compile.test.ts',
];

console.log(`upgrade gate for ${image}`);
const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'node', ...GATE_TESTS], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DOCEDIT_EXPORT_IMAGE: image, DOCEDIT_REQUIRE_SANDBOX: '1' },
});
console.log(
  r.status === 0 ? `upgrade gate passed for ${image}` : `upgrade gate FAILED for ${image}`,
);
process.exit(r.status ?? 1);
