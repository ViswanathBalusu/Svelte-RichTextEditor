// HIS-046 criteria 2 and 5 (lane w7, 2026-11-17): the history routes of the control plane, per class
// of reader, over HTTP, now that diff, history, attribution and the versions are served (HIS-026).
//
// The document has a confidential region (text "Liability", one field in it), and, outside it, a
// field marked sensitive. Three classes read it:
//   A  an editor of the document (so the default history gate lets the whole log through, ADR 0034)
//      with no grant on the region: neither the region nor the sensitive value;
//   B  an editor who also holds a grant on the region: the region, but not the sensitive value;
//   C  an owner (`manage`): everything, as the positive control.
// For A and B no response of a history route may carry what the class may not read, and a `region`
// or `field` filter on a scope the class cannot read is refused as if the scope did not exist
// (criterion 2), including a field inside a region the class cannot read.
// Memory storage and PostgreSQL. The commits are appended through the log store, as a room would.
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
const REGION_FIELD = 'ffRegion00000001';
const SENSITIVE_FIELD = 'ffSensitive00001';
const LEGAL_WORD = 'Liability';
const REGION_VALUE = 'REGIONFIELDVALUE';
const SENSITIVE_VALUE = 'SENSITIVEVALUE';

const field = (id: string, key: string, value: string, extra: Record<string, unknown> = {}) => ({
  type: 'form_field',
  attrs: { id, key, kind: 'text', label: key, assignee: 'tenant', value, ...extra },
});

/** The regions fixture, the legal region confidential, a field inside it, and a sensitive field outside. */
function fixture(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: Array<Record<string, unknown>> }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  const body = d.doc.content[1]!.content;
  const intro = body[0] as { content: unknown[] };
  intro.content.push(
    { type: 'text', text: ' ' },
    field(SENSITIVE_FIELD, 'tenant.name', SENSITIVE_VALUE, { sensitive: true }),
  );
  const legal = body.find((b) => (b['attrs'] as { id?: string }).id === LEGAL) as {
    attrs: Record<string, unknown>;
    content: unknown[];
  };
  legal.attrs['policy'] = 'confidential';
  legal.content.push({
    type: 'paragraph',
    attrs: { id: 'pLegalField00001', style: 'Normal' },
    content: [field(REGION_FIELD, 'clause.text', REGION_VALUE)],
  });
  return d as unknown as Record<string, unknown>;
}

const typing = (pos: number, text: string) => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

/** The position inside the start of the textblock with `id`. */
function insideOf(doc: unknown, id: string): number {
  const root = cdmSchema().nodeFromJSON(doc);
  let at = -1;
  root.descendants((n, pos) => {
    if (at < 0 && n.attrs['id'] === id) at = pos + 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no node ${id}`);
  return at;
}

async function append(
  h: Harness,
  doc: string,
  user: string,
  pos: number,
  scopes: string[],
): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [
      {
        seq: head.seq + 1,
        id: uuid7(),
        kind: 'steps' as const,
        steps: [typing(pos, 'x')] as never,
        user,
        session: 'session-test',
        time: h.now(),
        origin: 'input',
        scopes,
        revision: perms.revision,
        cdm: 1,
        engine: 'pm-steps/1',
        retired: [],
        claimed: [],
      },
    ],
  });
  if (r.status !== 'ok') throw new Error(`append refused: ${r.status}`);
  return head.seq + 1;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`history routes per class of reader (${storage}, HIS-046 criteria 2 and 5)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    let head = 0;
    let tokens: { A: string; B: string; C: string };

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {});
      doc = await h.createDocument({ content: fixture(), title: 'HIS-046 classes' });
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      expect(content.status, content.text).toBe(200);
      const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
      const beth = (await h.parts.users.resolve(h.tenant, 'beth')).surrogate;
      // The later block first, so the position of the earlier one does not move.
      await append(h, doc, bob, insideOf(content.json.doc, 'pOpen00000000001'), [
        'region:rOpen00000000001',
      ]);
      await append(h, doc, bob, insideOf(content.json.doc, 'pLegal0000000001'), [
        `region:${LEGAL}`,
      ]);
      head = await append(h, doc, bob, insideOf(content.json.doc, 'pIntro0000000001'), [
        `field:${REGION_FIELD}`,
        `field:${SENSITIVE_FIELD}`,
      ]);
      await h.parts.grants.change(
        { tenant: h.tenant, doc },
        {
          putGrants: [
            { region: LEGAL, principal: `user:${beth}`, role: 'editor', expiresAt: null },
          ],
        },
        { actor: 'system' },
      );
      tokens = {
        A: h.userToken({ [doc]: 'editor' }, { sub: 'vera' }),
        B: h.userToken({ [doc]: 'editor' }, { sub: 'beth' }),
        C: h.userToken({ [doc]: 'owner' }, { sub: 'olga' }),
      };
    });
    afterAll(async () => {
      await h?.close();
    });

    const get = (path: string, token: string) =>
      h.call('GET', `/v1/documents/${doc}${path}`, { token });
    /** The reads of history, each with the range the story names. */
    const reads = () => [
      '/history',
      '/history?namedOnly=false',
      `/history?fromSeq=0&toSeq=${head}`,
      `/diff?fromSeq=0&toSeq=${head}`,
      `/diff?fromSeq=0&toSeq=${head}&granularity=char`,
      '/attribution',
      `/attribution?seq=${head}`,
      `/content?seq=${head}`,
      '/content?seq=0',
      '/versions',
      '/activity',
      '/commits',
    ];

    it.skipIf(skip)(
      'shows the positive control: an owner reads the hidden text and values',
      async () => {
        const r = await get(`/content?seq=${head}`, tokens.C);
        expect(r.status, r.text).toBe(200);
        expect(r.text).toContain(LEGAL_WORD);
        expect(r.text).toContain(SENSITIVE_VALUE);
        for (const path of ['/history', '/attribution', `/diff?fromSeq=0&toSeq=${head}`])
          expect((await get(path, tokens.C)).status, path).toBe(200);
      },
    );

    it.skipIf(skip)(
      'class A (no grant on the region) gets no hidden text or value from any history read (criterion 5)',
      async () => {
        for (const path of reads()) {
          const r = await get(path, tokens.A);
          expect(r.status, `${path}: ${r.text}`).toBeLessThan(500);
          for (const word of [LEGAL_WORD, REGION_VALUE, SENSITIVE_VALUE])
            expect(r.text, `${path} leaks ${word}`).not.toContain(word);
        }
      },
    );

    it.skipIf(skip)(
      'class B (grant on the region, not on the sensitive value) gets the region but not the value (criterion 5)',
      async () => {
        for (const path of reads()) {
          const r = await get(path, tokens.B);
          expect(r.status, `${path}: ${r.text}`).toBeLessThan(500);
          expect(r.text, `${path} leaks the sensitive value`).not.toContain(SENSITIVE_VALUE);
        }
        const own = await get(`/content?seq=${head}`, tokens.B);
        expect(own.text).toContain(LEGAL_WORD);
      },
    );

    it.skipIf(skip)(
      'refuses a region or field filter on a scope the class cannot read, as if it did not exist (criterion 2)',
      async () => {
        // What a scope that does not exist answers, asked by an owner who can read everything.
        const noField = await get('/history?field=fNoSuchField0001', tokens.C);
        const noRegion = await get('/history?region=rNoSuchRegion001', tokens.C);
        expect([noField.status, noRegion.status]).toEqual([404, 404]);
        const cases: Array<[string, string, string[]]> = [
          // [class, token, filters answered 404]
          ['A', tokens.A, [`region=${LEGAL}`, `field=${REGION_FIELD}`, `field=${SENSITIVE_FIELD}`]],
          ['B', tokens.B, [`field=${SENSITIVE_FIELD}`]],
        ];
        for (const [name, token, filters] of cases) {
          for (const filter of filters) {
            for (const route of ['history', 'attribution', 'diff']) {
              const range = route === 'diff' ? `fromSeq=0&toSeq=${head}&` : '';
              if (route === 'attribution' && filter.startsWith('field=')) continue;
              if (route === 'diff' && filter.startsWith('field=')) continue;
              const r = await get(`/${route}?${range}${filter}`, token);
              expect(r.status, `${name} ${route} ?${filter}: ${r.text}`).toBe(404);
              expect(r.json.code).toBe('not_found');
              for (const word of [REGION_VALUE, SENSITIVE_VALUE])
                expect(r.text).not.toContain(word);
            }
          }
        }
        // What the class may read is still served: B reads the region filter and the field in it.
        expect((await get(`/history?region=${LEGAL}`, tokens.B)).status).toBe(200);
        expect((await get(`/history?field=${REGION_FIELD}`, tokens.B)).status).toBe(200);
        expect((await get(`/history?field=${SENSITIVE_FIELD}`, tokens.C)).status).toBe(200);
      },
    );
  });
}
