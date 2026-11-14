/**
 * The reference host is a SvelteKit application (13 §11.2), built with adapter-node into
 * `dist/host/` and served by scripts/serve.ts; SvelteKit's own output goes to `dist/.svelte-kit/`,
 * so that both are build output for the workspace's lint and format ignores. SvelteKit 3 takes its
 * configuration here (there is no svelte.config.js). The content security policy's script and
 * style rules are SvelteKit's, with a nonce per response; hooks.server.ts adds the rules that
 * depend on where the document service is.
 */
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ out: 'dist/host', precompress: false }),
      outDir: 'dist/.svelte-kit',
      // DOM-built templates, as in the element (FE-016): no HTML strings parsed at run time.
      compilerOptions: { fragments: 'tree' },
      csp: {
        mode: 'nonce',
        directives: {
          'default-src': ['self'],
          'script-src': ['self'],
          'style-src': ['self'],
          'img-src': ['self', 'data:', 'blob:'],
          'font-src': ['self'],
          'object-src': ['none'],
          'base-uri': ['none'],
          'form-action': ['self'],
          'frame-ancestors': ['none'],
        },
      },
    }),
  ],
  server: { host: '127.0.0.1' },
});
