/**
 * The client entry of the host that is rendered on a server (FE-124 criterion 3): hydrates the
 * server's markup, then gives the `<doc-editor>` that the markup contains its backend, as a host
 * does once its own framework is running. Status for the test is on `globalThis.__ssrHost`.
 */
import { hydrate } from 'svelte';
import { MockService } from '@docedit/backend-mock';
import { spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';
import SsrHost from './SsrHost.svelte';

const status: {
  serverMarkup: boolean;
  hydrated: boolean;
  ready: boolean;
  sameNode: boolean;
  error: string | null;
} = { serverMarkup: false, hydrated: false, ready: false, sameNode: false, error: null };
Object.assign(globalThis, { __ssrHost: status });

try {
  const target = document.getElementById('host-app')!;
  const before = target.querySelector('doc-editor');
  status.serverMarkup = before !== null;
  hydrate(SsrHost, { target });
  status.hydrated = true;
  const el = target.querySelector('doc-editor') as (HTMLElement & { backend: unknown }) | null;
  if (!el) throw new Error('the hydrated host has no doc-editor');
  // Hydration keeps the server's node: the element is not replaced.
  status.sameNode = el === before;
  const service = new MockService();
  const docId = service.createDocument(spikeDocument() as unknown as CdmEnvelope);
  el.addEventListener('de-ready', () => {
    status.ready = true;
  });
  el.addEventListener('de-error', (e) => {
    status.error = JSON.stringify((e as CustomEvent).detail);
  });
  el.backend = service.backend({ sub: 'ssr-host' }, { [docId]: 'editor' });
  el.setAttribute('doc-id', docId);
} catch (e) {
  status.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
