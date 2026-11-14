/**
 * Spike S2 demo page: `<doc-editor>` under the policy the test sends with the page, loaded from
 * the in-memory backend. The style nonce comes from the page (the server writes it into a meta
 * element). Query: `fallback` forces the nonce `<style>` path.
 */
import '../src/index.ts';
import { MockService } from '@docedit/backend-mock';
import { SPIKE_IDS, spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';
import type { DocEditorElement } from '../src/doc-editor.ts';
import { installSpikeHooks } from '../src/testing.ts';

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
el.backend = service.backend(user, { [docId]: 'editor' });
el.setAttribute('doc-id', docId);
document.getElementById('mount')!.append(el);

Object.assign(globalThis, {
  __s2: { el, nonce, trustedTypes: typeof (globalThis as { trustedTypes?: unknown }).trustedTypes },
});
