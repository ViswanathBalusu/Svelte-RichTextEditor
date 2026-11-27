/**
 * Builds everything the demo server serves: `node demo/build.ts`.
 * - dist/demo: the component from source with the demo pages and test hooks (`fragments: "tree"`),
 *   the spike S2 control (`fragments: "html"`), the Svelte host application and the host that is
 *   rendered on a server and hydrated (ssr-host, FE-124) and the framework hosts of the host matrix
 *   (React, Vue, Angular and SvelteKit, FE-124);
 * - dist/lib: the library build and the PDF viewer's page, as published (scripts/build.ts).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'vite';
import { buildLibrary } from '../scripts/build.ts';
import {
  demoConfig,
  elementDir,
  FRAMEWORK_HOSTS,
  frameworkHostConfig,
  ssrHostClientConfig,
  ssrHostServerConfig,
  svelteHostConfig,
} from '../scripts/vite-configs.ts';
import { prerenderSsrHost } from './ssr-host/prerender.ts';

// The builds read the reference host's tsconfig, which extends "$app/tsconfig". `svelte-kit sync`
// writes that file under the host's node_modules. A fresh install (the hosted Playwright jobs) has
// none, and the build stops with "Tsconfig not found $app/tsconfig".
const sync = spawnSync('pnpm --filter @docedit/reference-host exec svelte-kit sync', {
  shell: true,
  stdio: 'inherit',
});
if (sync.status !== 0) throw new Error('svelte-kit sync failed');

const started = Date.now();
await build(demoConfig('tree', true));
await build(demoConfig('html', false));
await build(svelteHostConfig());
await build(ssrHostClientConfig());
await build(ssrHostServerConfig());
await prerenderSsrHost();
// The framework hosts of the host matrix (FE-124 criterion 1).
for (const name of FRAMEWORK_HOSTS) await build(frameworkHostConfig(name));
// SvelteKit reads its project from the working directory, so its build runs there.
// Its vite.config.ts is the project's configuration, so SvelteKit's own tools find it too.
const viteBin = join(
  dirname(createRequire(import.meta.url).resolve('vite/package.json')),
  'bin/vite.js',
);
const kit = spawnSync(process.execPath, [viteBin, 'build'], {
  cwd: join(elementDir, 'demo/hosts/sveltekit'),
  stdio: 'inherit',
});
if (kit.status !== 0) throw new Error('the SvelteKit host did not build');
// The demo is still served when the library's own checks fail (size, shape, WebAssembly), so that
// the suites can run and say what is wrong; `node scripts/build.ts` is the build that fails.
const passed = await buildLibrary();
if (!passed) console.warn('demo build: the library build failed one of its checks (see above)');
console.log(`demo build: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
