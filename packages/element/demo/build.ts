/**
 * Builds everything the demo server serves: `node demo/build.ts`.
 * - dist/demo: the component from source with the demo pages and test hooks (`fragments: "tree"`),
 *   the spike S2 control (`fragments: "html"`), the Svelte host application and the host that is
 *   rendered on a server and hydrated (ssr-host, FE-124);
 * - dist/lib: the library build and the PDF viewer's page, as published (scripts/build.ts).
 */
import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import { buildLibrary } from '../scripts/build.ts';
import {
  demoConfig,
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
// The demo is still served when the library's own checks fail (size, shape, WebAssembly), so that
// the suites can run and say what is wrong; `node scripts/build.ts` is the build that fails.
const passed = await buildLibrary();
if (!passed) console.warn('demo build: the library build failed one of its checks (see above)');
console.log(`demo build: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
