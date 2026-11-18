/**
 * Spike S2 demo page: `<doc-editor>` under the policy the test sends with the page, loaded from
 * the in-memory backend. The style nonce comes from the page (the server writes it into a meta
 * element). Query: `fallback` forces the nonce `<style>` path; `fonts` gives the backend a `fonts`
 * port whose manifest lists one file of the demo server; `proofing` and `assistant` give it scripted
 * ports of those names (the in-memory backend has neither), for the strict-policy runs of FE-125.
 */
import '../src/index.ts';
import { MockService } from '@docedit/backend-mock';
import { SPIKE_IDS, spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';
import type { DocEditorElement } from '../src/doc-editor.ts';
import { installSpikeHooks, internalsOf } from '../src/testing.ts';

const params = new URLSearchParams(location.search);
const nonce = document.querySelector('meta[name="de-nonce"]')?.getAttribute('content') ?? undefined;

const service = new MockService();
const user = { sub: 'spike', name: 'Spike user' };
const docId = service.createDocument(spikeDocument() as unknown as CdmEnvelope, {
  grants: [{ region: SPIKE_IDS.region, principal: `user:${user.sub}`, role: 'editor' }],
});

const el = document.createElement('doc-editor') as DocEditorElement;
installSpikeHooks(el);
el.config = { forceStyleFallback: params.has('fallback'), ...(nonce ? { styleNonce: nonce } : {}) };
const backend = service.backend(user, { [docId]: 'editor' });
if (params.has('fonts')) {
  // A `fonts` port, which the in-memory backend lacks (FE-125): one file of the demo server, so the
  // session registers it under its hash alias (FE-061). The digest only names the alias here; the
  // page does not check the bytes against it.
  const run = params.get('run') ?? '';
  Object.defineProperty(backend, 'fonts', {
    value: {
      manifest: () =>
        Promise.resolve({
          families: [
            {
              family: 'S2 Serif',
              licence: 'OFL-1.1',
              faces: [
                {
                  url: `${location.origin}/vendor/mathlive/fonts/KaTeX_Main-Regular.woff2?run=${run}`,
                  sha256: '5'.repeat(64),
                  weight: 400,
                  italic: false,
                },
              ],
            },
          ],
        }),
    },
  });
}
if (params.has('proofing')) {
  // One finding on the first three letters of the first block that has text, so the finding
  // decoration is drawn on the page and the proofing commands exist (UX-041).
  Object.defineProperty(backend, 'proofing', {
    value: {
      check: (request: { blocks: readonly { blockId: string; text: string }[] }) =>
        Promise.resolve(
          request.blocks
            .filter((b) => b.text.length >= 3)
            .slice(0, 1)
            .map((b) => ({
              blockId: b.blockId,
              from: 0,
              to: 3,
              kind: 'spelling',
              message: 'Unknown word',
              suggestions: ['Fix'],
            })),
        ),
      addWord: () => Promise.resolve(),
    },
  });
}
if (params.has('assistant')) {
  // One scripted answer, so the assistant pane runs a whole request on the page.
  Object.defineProperty(backend, 'assistant', {
    value: {
      async *request() {
        yield { kind: 'text', text: 'Scripted answer.' };
        yield { kind: 'done', agent: 'agt-s2' };
      },
    },
  });
}
el.backend = backend;
el.setAttribute('doc-id', docId);
document.getElementById('mount')!.append(el);

Object.assign(globalThis, {
  __s2: {
    el,
    nonce,
    openPane: (id: string) => internalsOf(el).editor!.openPane(id),
    proofingFindings: () => internalsOf(el).editor!.core.proofingFindings().length,
    trustedTypes: typeof (globalThis as { trustedTypes?: unknown }).trustedTypes,
  },
});
