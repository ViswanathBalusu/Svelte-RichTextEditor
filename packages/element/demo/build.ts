/**
 * Builds everything the demo server serves: `node demo/build.ts`.
 * - dist/demo: the component from source with the demo pages and test hooks (`fragments: "tree"`),
 *   the spike S2 control (`fragments: "html"`), the Svelte host application and the host that is
 *   rendered on a server and hydrated (ssr-host, FE-124);
 * - dist/lib: the library build and the PDF viewer's page, as published (scripts/build.ts).
 */
import { build } from 'vite';
import { buildLibrary } from '../scripts/build.ts';
import {
  demoConfig,
  ssrHostClientConfig,
  ssrHostServerConfig,
  svelteHostConfig,
} from '../scripts/vite-configs.ts';
import { prerenderSsrHost } from './ssr-host/prerender.ts';

const started = Date.now();
await build(demoConfig('tree', true));
await build(demoConfig('html', false));
await build(svelteHostConfig());
await build(ssrHostClientConfig());
await build(ssrHostServerConfig());
await prerenderSsrHost();
const withinBudget = await buildLibrary();
if (!withinBudget) console.warn('demo build: the library is over its size budget (see above)');
console.log(`demo build: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
