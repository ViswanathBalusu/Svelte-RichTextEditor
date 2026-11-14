/**
 * Loads the component on the Svelte host page (spike S2): the build compiled with
 * `fragments: "tree"` (default) or the control build compiled with `fragments: "html"`
 * (`?bundle=control`). A dynamic import is not a Trusted Types sink, so the host needs no policy
 * of its own for it. The backend is this script's own in-memory one: the element accepts any
 * object that implements the ports (05 §8.3).
 */
import { MockService } from '@docedit/backend-mock';
import { spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';

const params = new URLSearchParams(location.search);
const bundle =
  params.get('bundle') === 'control' ? '/control/assets/doc-editor.js' : '/assets/doc-editor.js';
const status: { bundle: string; loaded: boolean; mounted: boolean; error: string | null } = {
  bundle,
  loaded: false,
  mounted: false,
  error: null,
};
Object.assign(globalThis, { __hostLoader: status });

try {
  await import(/* @vite-ignore */ bundle);
  status.loaded = true;
  const service = new MockService();
  const docId = service.createDocument(spikeDocument() as unknown as CdmEnvelope);
  // Hooks for the two-instance test (FE-124 criterion 5): more backends and documents on this page.
  Object.assign(globalThis, {
    __hostFixtures: {
      docId,
      backend: (sub: string) => service.backend({ sub }, { [docId]: 'editor' }),
      newDocument: () => service.createDocument(spikeDocument() as unknown as CdmEnvelope),
      backendFor: (sub: string, id: string) => service.backend({ sub }, { [id]: 'editor' }),
    },
  });
  const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
  el.addEventListener('de-ready', () => {
    status.mounted = true;
  });
  el.addEventListener('de-error', (e) => {
    status.error = JSON.stringify((e as CustomEvent).detail);
  });
  el.backend = service.backend({ sub: 'host' }, { [docId]: 'editor' });
  el.setAttribute('doc-id', docId);
  document.getElementById('mount')!.append(el);
} catch (e) {
  status.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
