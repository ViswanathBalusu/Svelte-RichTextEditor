/**
 * Spike S1 demo page: one `<doc-editor>` on the spike document, loaded from the in-memory backend
 * (packages/backend-mock) as a host would load it, plus a shadow root of the host page's own, for
 * the check of ProseMirror's `ShadowRoot.prototype.getSelection` patch (02 §8).
 * Query: `shim=library` (let ProseMirror patch the prototype), `grace=<ms>`, `keepalive`,
 * `defer=0` (apply remote commits during composition at once, to reproduce the failure the core's
 * deferral avoids), `sync=1` (open the channel, so the core's sync client runs).
 */
import '../src/index.ts';
import { MockService } from '@docedit/backend-mock';
import { SPIKE_IDS, spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';
import type { Backend } from '@docedit/protocol';
import type { DocEditorElement } from '../src/doc-editor.ts';
import { installSpikeHooks } from '../src/testing.ts';

const params = new URLSearchParams(location.search);
const shim = params.get('shim') === 'library' ? 'library' : 'instance';

const probe = document.getElementById('host-probe')!;
const probeRoot = probe.attachShadow({ mode: 'open' });
const span = document.createElement('span');
span.textContent = 'Shadow content that belongs to the host page';
probeRoot.append(span);

const proto = ShadowRoot.prototype as ShadowRoot & { getSelection?: unknown };
const before = {
  ownProperty: Object.prototype.hasOwnProperty.call(proto, 'getSelection'),
  type: typeof proto.getSelection,
};

// The spike user edits everything: the body, the header story, and the restricted region through
// a grant (07 §4).
const service = new MockService();
const user = { sub: 'spike', name: 'Spike user' };
const docId = service.createDocument(spikeDocument() as unknown as CdmEnvelope, {
  grants: [{ region: SPIKE_IDS.region, principal: `user:${user.sub}`, role: 'editor' }],
});

const el = document.createElement('doc-editor') as DocEditorElement;
installSpikeHooks(el);
el.config = {
  selectionShim: shim,
  graceMs: Number(params.get('grace') ?? 30_000),
  deferRemoteWhileComposing: params.get('defer') !== '0',
};
if (params.has('keepalive')) el.setAttribute('keep-alive', '');
// The spike's remote commits come from the harness's stand-in, not from a server, so by default
// the channel never opens and the core's sync client stays detached, as in spike S1. `sync=1`
// opens it.
const backend = service.backend(user, { [docId]: 'editor' });
el.backend = params.get('sync') === '1' ? backend : detached(backend);
el.setAttribute('doc-id', docId);
document.getElementById('mount')!.append(el);

function detached(b: Backend): Backend {
  return {
    get features() {
      return b.features;
    },
    connect: () => b.connect(),
    close: () => b.close(),
    auth: b.auth,
    permissions: b.permissions,
    sync: {
      loadContent: (id, seq) => b.sync.loadContent(id, seq),
      open: () => new Promise<never>(() => {}),
    },
  };
}

Object.assign(globalThis, {
  __s1: { before, probeRoot, model: 'paragraph', shim, el, service, docId },
});
