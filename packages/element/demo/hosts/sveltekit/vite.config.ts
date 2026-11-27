/**
 * The SvelteKit host of the host matrix (FE-124 criterion 1): a SvelteKit application with its
 * client router, built with Vite and SvelteKit's own plugin. `demo/build.ts` runs `vite build` here.
 * A small adapter of its own writes the client files and one fallback page under
 * `dist/demo/hosts/sveltekit`; the router is the hash router, so one page serves every route.
 * SvelteKit reads this file again in the processes it forks, so the settings live here and not in an
 * inline configuration.
 */
import { sveltekit } from '@sveltejs/kit/vite';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { BROWSER_MINIMUMS, demoDir, distDir } from '../../../scripts/vite-configs.ts';

const root = dirname(fileURLToPath(import.meta.url));
const base = '/hosts/sveltekit';
const out = join(demoDir, 'hosts', 'sveltekit');

export default defineConfig({
  root,
  logLevel: 'warn',
  build: { target: [...BROWSER_MINIMUMS], assetsInlineLimit: 0, sourcemap: true },
  plugins: [
    sveltekit({
      // SvelteKit resolves this against the working directory, which is this directory.
      outDir: relative(root, join(distDir, 'sveltekit-host-build')),
      paths: { base },
      router: { type: 'hash' },
      adapter: {
        name: 'host-matrix',
        async adapt(builder) {
          builder.rimraf(out);
          builder.mkdirp(out);
          builder.writeClient(out);
          await builder.generateFallback(join(out, 'index.html'));
        },
      },
    }),
  ],
});
