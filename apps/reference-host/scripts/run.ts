/**
 * `node apps/reference-host/scripts/run.ts <service|host|worker>`: starts one long-running part of
 * the demo stack with the environment the stack gives it (scripts/lib/stack.ts), in this process.
 * scripts/stack.ps1 starts each part this way on a development machine; compose.yaml runs the same
 * command in a container.
 *
 * - service: the document service (services/document-service, src/main.ts);
 * - host: the reference host (scripts/serve.ts, over the SvelteKit build);
 * - worker: the export worker (services/export-worker, src/main.ts).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir, readSecrets, roleEnv, stackSettings, type Role } from './lib/stack.ts';

const role = process.argv[2] as Role | undefined;
if (role !== 'service' && role !== 'host' && role !== 'worker') {
  console.error('usage: run.ts <service|host|worker>');
  process.exit(2);
}

const s = stackSettings();
const secrets = await readSecrets(dataDir()).catch(() => {
  console.error('No stack secrets yet: run scripts/setup.ts (or stack.ps1 up) first.');
  process.exit(2);
});
for (const [k, v] of Object.entries(roleEnv(role, s, secrets))) process.env[k] = v;

const require = createRequire(import.meta.url);
// Files of workspace packages are found through the packages themselves, not by relative paths:
// the document service exports `src/index.ts`, next to which its `main.ts` lives; the export
// worker has no `exports` field.
const entry =
  role === 'service'
    ? join(dirname(require.resolve('@docedit/document-service')), 'main.ts')
    : role === 'worker'
      ? join(dirname(require.resolve('@docedit/export-worker/package.json')), 'src', 'main.ts')
      : join(import.meta.dirname, 'serve.ts');
if (!existsSync(entry)) {
  console.error(`run.ts ${role}: ${entry} does not exist`);
  process.exit(3);
}
await import(pathToFileURL(entry).href);
