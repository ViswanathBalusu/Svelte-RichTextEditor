/**
 * The production-bundle page (`pages/lib.html`): loads the library build (`/lib/doc-editor.js`,
 * the distributable of FE-002) by URL, as a host does, with no test hook inside it. The in-memory
 * backend comes from this script, so the element is driven through its public API only.
 *
 * `window.__lib` offers `service`, `docId`, `backend(sub)`, `load()` (imports the library) and
 * `defineFake(version, release)` (registers another class under `doc-editor` first, for the
 * version checks of FE-001). `fieldsDocId` and `rulesDocId` are the form document without and with
 * a rule, and `backendFor(sub, docIds)` opens any of them (FND-008).
 */
import { MockService } from '@docedit/backend-mock';
import { spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';
import { fieldsDocument, rulesDocument } from './fields-document.ts';

const service = new MockService();
const docId = service.createDocument(spikeDocument() as unknown as CdmEnvelope);
const fieldsDocId = service.createDocument(fieldsDocument());
const rulesDocId = service.createDocument(rulesDocument());

const LIBRARY = '/lib/doc-editor.js';

Object.assign(globalThis, {
  __lib: {
    service,
    docId,
    fieldsDocId,
    rulesDocId,
    library: LIBRARY,
    backend: (sub: string) => service.backend({ sub, name: sub }, { [docId]: 'editor' }),
    backendFor: (sub: string, docIds: string[]) =>
      service.backend(
        { sub, name: sub },
        Object.fromEntries(docIds.map((id) => [id, 'editor' as const])),
      ),
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
