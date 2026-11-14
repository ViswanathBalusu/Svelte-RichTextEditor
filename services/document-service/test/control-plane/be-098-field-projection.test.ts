// Field reads outside a room are the requester's projection (BE-098 criterion 1; ADR 0019; 12 §3).
// A form field inside a region hidden from the reader is not in the field list or in the values
// of the field routes; the owner, who sees the whole document, gets it. Runs over real HTTP against
// the in-process service, with in-memory storage and with PostgreSQL (lane U-BE-085-098).
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
const LEGAL_FIELD_ID = 'fe00000000legal1';
const OPEN_FIELD_ID = 'fe00000000open01';

/** The legal region is hidden from everyone but owners (the same policy shape as routes.content). */
const visibility: Visibility = (conn) =>
  conn.role === 'owner'
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

/** The regions fixture with one form field inside the legal region and one outside it. */
function documentWithFieldsInRegions(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: Array<Record<string, unknown>> }> };
  };
  d.requires = ['fields'];
  const body = d.doc.content[1]!;
  const legal = body.content.find(
    (n) => n['attrs'] && (n['attrs'] as { id: string }).id === LEGAL,
  )!;
  (legal['content'] as unknown[]).push({
    type: 'paragraph',
    attrs: { id: 'pLegalField00001', style: 'Normal' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: LEGAL_FIELD_ID,
          key: 'legal.name',
          kind: 'text',
          label: 'Legal name',
          assignee: 'tenant',
          value: 'Secret Ada',
        },
      },
    ],
  });
  const open = body.content.find(
    (n) => n['attrs'] && (n['attrs'] as { id: string }).id === 'rOpen00000000001',
  )!;
  (open['content'] as unknown[]).push({
    type: 'paragraph',
    attrs: { id: 'pOpenField000001', style: 'Normal' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: OPEN_FIELD_ID,
          key: 'open.name',
          kind: 'text',
          label: 'Open name',
          assignee: 'tenant',
          value: 'Public Bob',
        },
      },
    ],
  });
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`field reads are the requester projection (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { views: { ...FULL_VIEWS, visibility } });
    });
    afterAll(async () => {
      await h?.close();
    });

    async function setup() {
      const doc = await h.createDocument({ content: documentWithFieldsInRegions() });
      const reader = h.userToken({ [doc]: 'editor' });
      const owner = h.userToken({ [doc]: 'owner' });
      return { doc, reader, owner };
    }

    it.skipIf(skip)(
      'omits a field inside a region hidden from the reader from the field list (BE-098 criterion 1)',
      async () => {
        const { doc, reader, owner } = await setup();
        const asReader = await h.call('GET', `/v1/documents/${doc}/fields`, { token: reader });
        expect(asReader.status).toBe(200);
        const readerKeys = (asReader.json.items as Array<{ key: string }>).map((f) => f.key);
        expect(readerKeys).toContain('open.name');
        expect(readerKeys).not.toContain('legal.name');
        expect(asReader.text).not.toContain('Secret Ada');

        const asOwner = await h.call('GET', `/v1/documents/${doc}/fields`, { token: owner });
        const ownerKeys = (asOwner.json.items as Array<{ key: string }>).map((f) => f.key);
        expect(ownerKeys).toContain('legal.name');
      },
    );

    it.skipIf(skip)(
      'omits the value of a hidden field from the values, and carries the reader view token (BE-098 criterion 1)',
      async () => {
        const { doc, reader, owner } = await setup();
        const asReader = await h.call('GET', `/v1/documents/${doc}/field-values`, {
          token: reader,
        });
        expect(asReader.status).toBe(200);
        expect(asReader.json.values).toHaveProperty('open.name', 'Public Bob');
        expect(asReader.json.values).not.toHaveProperty('legal.name');
        expect(asReader.text).not.toContain('Secret Ada');
        expect(typeof asReader.json.view).toBe('string');

        const asOwner = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: owner });
        expect(asOwner.json.values).toHaveProperty('legal.name', 'Secret Ada');
        // The reader's class is not the owner's, so the view token differs (ADR 0019; D70).
        expect(asOwner.json.view).not.toBe(asReader.json.view);
      },
    );

    it.skipIf(skip)(
      'answers a keyed value request for a hidden field without its value (BE-098 criterion 1)',
      async () => {
        const { doc, reader } = await setup();
        const keyed = await h.call('GET', `/v1/documents/${doc}/field-values?key=legal.name`, {
          token: reader,
        });
        expect(keyed.text).not.toContain('Secret Ada');
        expect(keyed.json.values ?? {}).not.toHaveProperty('legal.name', 'Secret Ada');
      },
    );
  });
}
