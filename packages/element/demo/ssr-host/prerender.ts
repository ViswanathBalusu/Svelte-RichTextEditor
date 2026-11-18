/**
 * Renders the server host to `dist/demo/ssr-host/index.html` (FE-124 criterion 3). It imports the
 * server build of `SsrHost.svelte`, whose module imports the element's entry point: that import,
 * and the render, run in Node.js with no DOM. A throw there fails the build.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ssrHostDir, ssrHostServerDir } from '../../scripts/vite-configs.ts';

export async function prerenderSsrHost(): Promise<string> {
  const entry = join(ssrHostServerDir, 'entry-server.js');
  const { renderHost } = (await import(pathToFileURL(entry).href)) as {
    renderHost: () => { body: string; head: string };
  };
  const { body, head } = renderHost();
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FE-124: a host that renders on a server</title>
    ${head}
    <script type="module" src="/ssr-host/assets/client.js"></script>
  </head>
  <body>
    <main>
      <div id="host-app">${body}</div>
    </main>
  </body>
</html>
`;
  mkdirSync(ssrHostDir, { recursive: true });
  const file = join(ssrHostDir, 'index.html');
  writeFileSync(file, html);
  return file;
}
