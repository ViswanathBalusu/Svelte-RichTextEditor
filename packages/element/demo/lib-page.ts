/**
 * The production-bundle page (`pages/lib.html`): loads the library build (`/lib/doc-editor.js`,
 * the distributable of FE-002) by URL, as a host does, with no test hook inside it. The in-memory
 * backend comes from this script, so the element is driven through its public API only.
 *
 * `window.__lib` offers `service`, `docId`, `backend(sub)`, `load()` (imports the library) and
 * `defineFake(version, release)` (registers another class under `doc-editor` first, for the
 * version checks of FE-001).
 */
import { MockService } from '@docedit/backend-mock';
import { spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';

const service = new MockService();
const docId = service.createDocument(spikeDocument() as unknown as CdmEnvelope);

const LIBRARY = '/lib/doc-editor.js';

Object.assign(globalThis, {
  __lib: {
    service,
    docId,
    library: LIBRARY,
    backend: (sub: string) => service.backend({ sub, name: sub }, { [docId]: 'editor' }),
    load: () => import(/* @vite-ignore */ LIBRARY),
    defineFake(version: string, release: string): void {
      class Fake extends HTMLElement {
        static version = version;
        static release = release;
      }
      customElements.define('doc-editor', Fake);
    },
  },
});
