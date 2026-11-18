/**
 * Builds the key service emulator image (SoftHSM2 in Alpine; spike S8, SPK-021) with Podman:
 *
 *   node services/signing-service/scripts/build-keyservice-image.ts
 *
 * The container command is DOCEDIT_CONTAINER_CLI (default podman). The build fetches Alpine
 * packages (softhsm, opensc, openssl); the base image is pinned by digest in the Containerfile.
 * On a Windows or macOS remote client, set DOCEDIT_CONTAINER_CGROUPS=disabled if the build cannot
 * apply cgroup limits (see services/export-worker/src/container.ts).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { containerCli } from '../../export-worker/src/container.ts';
import { KEY_SERVICE_IMAGE } from '../test/support/softhsm.ts';

const context = fileURLToPath(new URL('../keyservice/', import.meta.url));
const r = spawnSync(
  containerCli(),
  ['build', '-f', `${context}Containerfile`, '-t', KEY_SERVICE_IMAGE, context],
  { stdio: 'inherit', windowsHide: true },
);
process.exit(r.status ?? 1);
