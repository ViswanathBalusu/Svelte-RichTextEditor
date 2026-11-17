/**
 * The embedding demo page (`pages/embed.html`): the element built from source with the test hooks
 * (src/testing.ts) and the in-memory backend, for the end-to-end suites of the embedding API
 * (e2e/element.spec.ts, e2e/pdf-viewer.spec.ts). The page creates no element itself: each test
 * creates them, in the order it wants to check.
 *
 * `window.__embed` offers:
 * - `service`, `docId`, `docText`: a mock document service with the spike document, and the texts
 *   no event may carry;
 * - `backend(sub, role)`: a backend for a user, as a host would pass it;
 * - `useEndpoint()`: makes `endpoint` + `getToken` produce mock backends, so that `getToken` is
 *   exercised; tokens are strings from `issueToken(sub, role)`;
 * - `events`: every `de-*` event seen on the document, with its target and detail;
 * - `internals(el)`, `openPdf(el, source)`, `viewers(el)` from the test hooks.
 */
import '../src/index.ts';
import { MockBackend, MockService, type MockToken } from '@docedit/backend-mock';
import { SPIKE_IDS, spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';
import type { DocRole } from '@docedit/protocol';
import { EVENT_NAMES } from '../src/events.ts';
import {
  internalsOf,
  openPdfViewer,
  setEndpointBackendFactory,
  spikeHarness,
  viewersOf,
} from '../src/testing.ts';

const service = new MockService();
const users: Record<string, { sub: string; name: string }> = {
  ada: { sub: 'ada', name: 'Ada' },
  bob: { sub: 'bob', name: 'Bob' },
  vic: { sub: 'vic', name: 'Vic' },
};
const docId = service.createDocument(spikeDocument() as unknown as CdmEnvelope, {
  grants: [{ region: SPIKE_IDS.region, principal: 'user:ada', role: 'editor' }],
});
const secondDocId = service.createDocument(spikeDocument() as unknown as CdmEnvelope);

/**
 * A body with a region in the middle and one as its last block (FE-038, FE-039): an open region
 * (`inherit`), so that an editor may type in both, and the paragraph that follows the last region.
 */
const REGION_IDS = {
  before: 'pBefore000000001',
  region: 'rMiddle000000001',
  first: 'pRegionFirst0001',
  last: 'pRegionLast00001',
  after: 'pAfter0000000001',
  endRegion: 'rEnd000000000001',
  endText: 'pEndText00000001',
  trailing: 'pTrailing0000001',
} as const;

function regionDocument(): CdmEnvelope {
  const p = (id: string, text: string) => ({
    type: 'paragraph',
    attrs: { id },
    ...(text ? { content: [{ type: 'text', text }] } : {}),
  });
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            p(REGION_IDS.before, 'Before region.'),
            {
              type: 'region',
              attrs: { id: REGION_IDS.region, title: 'Middle', policy: 'inherit' },
              content: [p(REGION_IDS.first, 'Region first.'), p(REGION_IDS.last, 'Region last.')],
            },
            p(REGION_IDS.after, 'After region.'),
            {
              type: 'region',
              attrs: { id: REGION_IDS.endRegion, title: 'End', policy: 'inherit' },
              content: [p(REGION_IDS.endText, 'End region text.')],
            },
            p(REGION_IDS.trailing, ''),
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

const regionsDocId = service.createDocument(regionDocument());

/**
 * A right-to-left document (FE-111 criterion 1): `settings.dir` is `rtl`; one paragraph has its own
 * `dir` `ltr` inside it, one an `rtl` `dir`, and one has no `dir` and so inherits the surface's.
 */
const RTL_IDS = {
  own: 'pRtlOwn000000001',
  ltr: 'pRtlLtr000000001',
  inherit: 'pRtlInherit00001',
} as const;
function rtlDocument(): CdmEnvelope {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'ar', dir: 'rtl' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: RTL_IDS.own, dir: 'rtl' },
              content: [{ type: 'text', text: 'مرحبا بالعالم' }],
            },
            {
              type: 'paragraph',
              attrs: { id: RTL_IDS.ltr, dir: 'ltr' },
              content: [{ type: 'text', text: 'Left to right text' }],
            },
            {
              type: 'paragraph',
              attrs: { id: RTL_IDS.inherit },
              content: [{ type: 'text', text: 'שלום עולם' }],
            },
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}
const rtlDocId = service.createDocument(rtlDocument());

/** The identifiers of the form document (FRW): two roles, and fields of a tenant and a landlord. */
const FIELD_IDS = {
  tenant: 'role_tenant',
  landlord: 'role_landlord',
  paragraph: 'pFields000000001',
  amount: 'fAmount000000001',
  name: 'fName00000000001',
  email: 'fEmail0000000001',
  landlordName: 'fLandlord0000001',
} as const;

/**
 * The spike document with the feature `fields`, two roles and a paragraph of form fields: three of
 * the tenant (one required, one with a range) and one of the landlord.
 */
function fieldsDocument(): CdmEnvelope {
  type J = Record<string, unknown>;
  const envelope = spikeDocument() as unknown as {
    requires: string[];
    doc: { content: Array<{ type: string; content: J[] }> };
  };
  envelope.requires = [...new Set([...envelope.requires, 'fields'])];
  const defs = envelope.doc.content.find((n) => n.type === 'defs');
  const body = envelope.doc.content.find((n) => n.type === 'body');
  if (!defs || !body) throw new Error('the spike document has no definitions or no body');
  // Roles follow the page setups and come before every other definition (03 §4.1).
  const after = defs.content.findLastIndex((n) => n['type'] === 'page_setup') + 1;
  defs.content.splice(
    after,
    0,
    { type: 'role_def', attrs: { id: FIELD_IDS.tenant, name: 'Tenant', color: '#1F77B4' } },
    { type: 'role_def', attrs: { id: FIELD_IDS.landlord, name: 'Landlord', color: '#FF7F0E' } },
  );
  const field = (id: string, key: string, kind: string, assignee: string, extra: J): J => ({
    type: 'form_field',
    attrs: { id, key, kind, assignee, value: null, ...extra },
  });
  body.content.push({
    type: 'paragraph',
    attrs: { id: FIELD_IDS.paragraph, style: 'Normal' },
    content: [
      { type: 'text', text: 'Fields: ' },
      field(FIELD_IDS.amount, 'tenant.amount', 'number', FIELD_IDS.tenant, {
        label: 'Amount',
        validation: { min: '0', max: '1000' },
      }),
      { type: 'text', text: ' ' },
      field(FIELD_IDS.name, 'tenant.name', 'text', FIELD_IDS.tenant, {
        label: 'Name',
        required: true,
      }),
      { type: 'text', text: ' ' },
      field(FIELD_IDS.email, 'tenant.email', 'text', FIELD_IDS.tenant, {
        label: 'E-mail',
        required: true,
        validation: { preset: 'email' },
      }),
      { type: 'text', text: ' ' },
      field(FIELD_IDS.landlordName, 'landlord.name', 'text', FIELD_IDS.landlord, {
        label: 'Landlord',
        required: true,
      }),
    ],
  });
  return envelope as unknown as CdmEnvelope;
}
const fieldsDocId = service.createDocument(fieldsDocument());

/**
 * A document one field short of the limit of form fields (I15; FRW-072 criterion 4): the spike
 * document with 1,999 text fields in one more paragraph. Made when first asked for, because no
 * other suite needs it.
 */
let fieldLimitDoc: string | null = null;
function fieldLimitDocId(): string {
  if (fieldLimitDoc !== null) return fieldLimitDoc;
  const envelope = spikeDocument() as unknown as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  envelope.requires = [...new Set([...envelope.requires, 'fields'])];
  const body = envelope.doc.content.find((n) => n.type === 'body');
  if (!body) throw new Error('the spike document has no body');
  body.content.push({
    type: 'paragraph',
    attrs: { id: 'pManyFields00001', style: 'Normal' },
    content: Array.from({ length: 1999 }, (_, i) => ({
      type: 'form_field',
      attrs: {
        id: `f${String(i).padStart(15, '0')}`,
        key: `k_${i}`,
        kind: 'checkbox',
        label: `K ${i}`,
        assignee: null,
        value: null,
      },
    })),
  });
  fieldLimitDoc = service.createDocument(envelope as unknown as CdmEnvelope);
  return fieldLimitDoc;
}

/** A backend for a participant who may only fill the fields of `roles` (12 §4.1; `MockUser.fill`). */
function fillBackend(sub: string, roles: string[] = [FIELD_IDS.tenant]) {
  return service.backend({ ...userOf(sub), fill: { roles } }, { [fieldsDocId]: 'filler' });
}

/** A service that offers no optional port: no `presence` port and no `presence` feature (PRO-099). */
const noPresence = new MockService({ presence: false });
const noPresenceDocId = noPresence.createDocument(spikeDocument() as unknown as CdmEnvelope);
function backendWithoutPresence(sub: string) {
  return noPresence.backend(userOf(sub), { [noPresenceDocId]: 'editor' });
}

function userOf(sub: string): { sub: string; name: string } {
  return users[sub] ?? { sub, name: sub };
}

function backend(
  sub: string,
  role: DocRole = 'editor',
  docs: string[] = [docId, secondDocId, regionsDocId, rtlDocId],
) {
  return service.backend(userOf(sub), Object.fromEntries(docs.map((d) => [d, role])));
}

const tokens = new Map<string, MockToken>();
function issueToken(sub: string, role: DocRole = 'editor'): string {
  const t = service.mintToken(userOf(sub), {
    [docId]: role,
    [secondDocId]: role,
    [regionsDocId]: role,
  });
  const value = `token-${t.jti}`;
  tokens.set(value, t);
  return value;
}

const endpointCalls: Array<{ endpoint: string; docId: string }> = [];
function useEndpoint(): void {
  setEndpointBackendFactory(({ endpoint, getToken, docId: forDoc }) => {
    endpointCalls.push({ endpoint, docId: forDoc });
    return new MockBackend(service, async () => {
      const value = await getToken({ docId: forDoc });
      const token = tokens.get(value);
      if (!token) throw new Error('the token was not issued by this page');
      return token;
    });
  });
}

const events: Array<{
  name: string;
  target: string;
  element: string | null;
  detail: unknown;
  composed: boolean;
  bubbles: boolean;
}> = [];
for (const name of EVENT_NAMES)
  document.addEventListener(name, (e) => {
    const target = e.target instanceof Element ? e.target.localName : String(e.target);
    events.push({
      name,
      target,
      element: e.target instanceof HTMLElement ? (e.target.dataset['test'] ?? null) : null,
      detail: (e as CustomEvent).detail,
      composed: e.composed,
      bubbles: e.bubbles,
    });
  });

Object.assign(globalThis, {
  __embed: {
    service,
    docId,
    secondDocId,
    regionsDocId,
    rtlDocId,
    fieldsDocId,
    FIELD_IDS,
    fillBackend,
    fieldLimitDocId,
    RTL_IDS,
    REGION_IDS,
    SPIKE_IDS,
    docText: [
      'Scope',
      'Alpha bravo charlie',
      'Liability is limited to',
      'Remote target paragraph.',
      'Last paragraph.',
      'Header text',
      'Footnote text',
    ],
    backend,
    backendWithoutPresence,
    noPresenceDocId,
    issueToken,
    useEndpoint,
    endpointCalls,
    events,
    internals: internalsOf,
    harness: spikeHarness,
    openPdf: openPdfViewer,
    viewers: viewersOf,
  },
});
