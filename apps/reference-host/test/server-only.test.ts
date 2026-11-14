// The private key of the token signer stays on the host's server (UX-092 criterion 3). The host's
// own routes are run against the real document service in memory (only `host()` is replaced): the
// layout and editor page loads, the token endpoint, and a static check that no file the browser
// receives names the signing key. The stack's own run in containers is not covered here.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFromTemplate } from '../src/lib/server/documents.ts';
import type * as HostModule from '../src/lib/server/host.ts';
import type { Host } from '../src/lib/server/host.ts';
import { SESSION_COOKIE } from '../src/lib/server/sessions.ts';
import { startHarness, type Harness } from './support.ts';

const current = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('../src/lib/server/host.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof HostModule>()),
  host: async () => current.host,
}));

const LAYOUT_ROUTE = '../src/routes/as/[user]/+layout.server.ts';
const DOC_ROUTE = '../src/routes/as/[user]/docs/[id]/+page.server.ts';
const TOKEN_ROUTE = '../src/routes/as/[user]/api/token/+server.ts';

interface LayoutRoute {
  load(event: unknown): Promise<unknown>;
}
interface DocRoute {
  load(event: unknown): Promise<unknown>;
}
interface TokenRoute {
  POST(event: unknown): Promise<Response>;
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  current.host = null;
});

function cookiesFor(host: Host, sub: string) {
  const session = host.sessions.create(sub);
  return { get: (name: string) => (name === SESSION_COOKIE ? session : undefined) };
}

/** Every file under `dir` whose path ends in one of the extensions. */
async function filesUnder(dir: string, exts: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path, exts)));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(path);
  }
  return out;
}

describe('the private key of the token signer stays on the server (UX-092 criterion 3)', () => {
  it('no response of the host routes names the private key, in a load, a token or a header', async () => {
    h = await startHarness({ tokenMode: 'host-signed' });
    current.host = h.host;
    const secret = h.host.config.signing!.privateJwk['d'];
    expect(typeof secret).toBe('string');

    const template = h.host.seed.templates.find((t) => t.key === 'two-regions')!;
    const entry = await createFromTemplate(h.host, {
      template,
      title: 'Server-only check',
      creator: 'u-olivia',
    });
    const cookies = cookiesFor(h.host, 'u-bob');

    const layout = (await import(/* @vite-ignore */ LAYOUT_ROUTE)) as LayoutRoute;
    const layoutData = await layout.load({ params: { user: 'u-bob' }, cookies, locals: {} });

    const docRoute = (await import(/* @vite-ignore */ DOC_ROUTE)) as DocRoute;
    const pageData = await docRoute.load({
      params: { user: 'u-bob', id: entry.id },
      parent: async () => layoutData,
    });

    const tokenRoute = (await import(/* @vite-ignore */ TOKEN_ROUTE)) as TokenRoute;
    const response = await tokenRoute.POST({
      params: { user: 'u-bob' },
      cookies,
      request: new Request('http://host.test/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId: entry.id }),
      }),
    });
    expect(response.status).toBe(200);
    const tokenBody = await response.text();
    // The token is issued, so the check is not vacuous.
    expect(tokenBody).toContain('"token"');

    const seen = [
      JSON.stringify(layoutData),
      JSON.stringify(pageData),
      tokenBody,
      JSON.stringify([...response.headers.entries()]),
    ].join('\n');
    expect(seen).not.toContain(secret as string);
  });

  it('no file the browser receives (routes, glue, components) names the signing key', async () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const clientSide = [
      ...(await filesUnder(join(src, 'routes'), ['.svelte', '.ts'])),
      ...(await filesUnder(join(src, 'lib', 'glue'), ['.ts'])),
    ].filter((f) => !/(\.server|\+server)\.ts$/.test(f));
    expect(clientSide.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of clientSide) {
      const text = await readFile(file, 'utf8');
      if (/privateJwk|signing\b|lib\/server\/tokens|lib\/server\/config/.test(text))
        offenders.push(relative(src, file));
    }
    expect(offenders).toEqual([]);
  });
});
