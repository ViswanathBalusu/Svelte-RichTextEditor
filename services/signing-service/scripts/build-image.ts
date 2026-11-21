/**
 * Builds the signing service image with Podman (FRW-052 criterion 1):
 *
 *   node services/signing-service/scripts/build-image.ts
 *
 * The build context is the repository root, narrowed by Containerfile.dockerignore. The container
 * command is DOCEDIT_CONTAINER_CLI (default podman); the tag is DOCEDIT_SIGNING_IMAGE. The build
 * fetches the base image (pinned by digest) and the production dependencies of the workspace.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { containerCli } from '../../export-worker/src/container.ts';

export const SIGNING_IMAGE =
  process.env['DOCEDIT_SIGNING_IMAGE'] ?? 'localhost/docedit-signing-service:dev';

const service = fileURLToPath(new URL('..', import.meta.url));
const root = fileURLToPath(new URL('../../..', import.meta.url));

if (import.meta.main) {
  const r = spawnSync(
    containerCli(),
    [
      'build',
      '-f',
      `${service}Containerfile`,
      '--ignorefile',
      `${service}Containerfile.dockerignore`,
      '-t',
      SIGNING_IMAGE,
      root,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  process.exit(r.status ?? 1);
}
