/**
 * Response headers of the reference host. SvelteKit writes the page's content security policy with
 * a nonce (vite.config.ts); this hook adds the two rules that depend on the deployment: the
 * document service the editor connects to (discovery, REST and the DEP WebSocket; 05 §2, §4), and
 * the origin of the PDF viewer's frame (FE-071). The element's own files, and the viewer with its
 * own policy, are served by routes/element.
 */
import type { Handle } from '@sveltejs/kit/hooks';
import { host } from './lib/server/host.ts';

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  const h = await host();
  const csp = response.headers.get('content-security-policy');
  if (csp && !event.url.pathname.startsWith('/element/')) {
    const service = new URL(h.config.endpoint);
    const ws = `${service.protocol === 'https:' ? 'wss:' : 'ws:'}//${service.host}`;
    const viewer = originOf(h.config.viewerUrl);
    response.headers.set(
      'content-security-policy',
      `${csp}; connect-src 'self' ${service.origin} ${ws}; frame-src ${viewer ?? "'self'"}`,
    );
  }
  // `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null` with a
  // form post, and SvelteKit's same-origin check of form posts then refuses the host's own forms.
  // Requests to the document service (CORS) always carry their origin; none carries a referrer.
  response.headers.set('referrer-policy', 'same-origin');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
};
