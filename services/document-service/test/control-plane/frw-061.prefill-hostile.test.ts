// FRW-061 criteria 4 and 6 through the real service (lane w4). A prefill whose values hold TeX
// control sequences, markup or spreadsheet formula characters stores them as typed data: the value
// read back is the string sent, and the commit holds it as the `value` of the field and nothing else.
// What the PDF shows of such a value is in packages/export-latex/src/frw-061-prefill-value.compile.test.ts.
// The same prefill sent twice with one `Idempotency-Key` is one commit (ADR 0342, accepted as
// decision 184). Memory storage and, when the test environment is up, PostgreSQL in Podman.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const fid = (n: number) => `fb${String(n).padStart(14, '0')}`;

/** Keep in step with the compile test of the export package. */
const HOSTILE: Record<string, string> = {
  'k.ctrlone': String.raw`CTRLONE \textbf{BOLDMARK} \input{/etc/passwd}`,
  'k.ctrltwo': String.raw`CTRLTWO \write18{id} \def\x{y} $$ \end{document}`,
  'k.specials': 'SPECIALS # $ % & _ { } ~ ^ \\ end',
  'k.markup': 'MARKUP <b>bold</b> <script>alert(1)</script> &amp; ]]>',
  'k.formula': `FORMULA =HYPERLINK("http://example.invalid","x") +cmd|' /C calc'!A0`,
};

function prefillDocument(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  const keys = Object.keys(HOSTILE);
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pHostile00000001', style: 'Normal' },
    content: keys.flatMap((key, i) => [
      {
        type: 'form_field',
        attrs: {
          id: fid(i + 1),
          key,
          kind: 'text',
          label: key,
          assignee: 'tenant',
          value: null,
        },
      },
      { type: 'text', text: ' ' },
    ]),
  });
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`prefill of hostile values and repeats (${storage}; FRW-061 criteria 4 and 6)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    const prefills = async (doc: string) => {
      const r = await h.call('GET', `/v1/documents/${doc}/commits?after=0&limit=200`, {
        token: h.serviceJwt(),
      });
      expect(r.status).toBe(200);
      return ((r.json.items ?? []) as Array<{ origin?: string }>).filter(
        (c) => c.origin === 'prefill',
      );
    };

    it.skipIf(skip)(
      'stores TeX control sequences, markup and formula characters exactly as typed (criterion 4, the data)',
      async () => {
        const doc = await h.createDocument({ content: prefillDocument() });
        const service = h.serviceJwt();
        const before = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
        const patch = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: service,
          body: { values: HOSTILE },
          headers: { 'if-match': before.headers.get('etag')! },
        });
        expect(patch.status, JSON.stringify(patch.json)).toBe(200);
        expect(patch.json.values).toEqual(HOSTILE);
        const after = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
        expect(after.json.values).toEqual(HOSTILE);
        // One commit, and its steps hold each value as a string attribute and no more.
        const commits = await h.parts.logs.read({ tenant: h.tenant, doc });
        const prefill = commits.filter((c) => c.origin === 'prefill');
        expect(prefill).toHaveLength(1);
        const steps = prefill[0]!.steps as Array<{
          stepType: string;
          attr?: string;
          value?: unknown;
        }>;
        expect(steps.every((s) => s.stepType === 'attr' && s.attr === 'value')).toBe(true);
        expect(steps.map((s) => s.value).sort()).toEqual(Object.values(HOSTILE).sort());
      },
      60_000,
    );

    it.skipIf(skip)(
      'writes one commit when the same request is repeated with the same Idempotency-Key (criterion 6)',
      async () => {
        const doc = await h.createDocument({ content: prefillDocument() });
        const service = h.serviceJwt();
        const before = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
        const send = (body: unknown, key: string, etag: string) =>
          h.call('PATCH', `/v1/documents/${doc}/field-values`, {
            token: service,
            body,
            headers: { 'if-match': etag, 'idempotency-key': key },
          });
        const etag = before.headers.get('etag')!;
        const body = { values: { 'k.markup': 'Ada', 'k.formula': 'Bea' } };
        const first = await send(body, 'prefill-key-061-a', etag);
        expect(first.status, JSON.stringify(first.json)).toBe(200);
        // The same request again: the answer of the first, and no second commit. The ETag is the
        // old one, which no longer matches the document: the stored answer comes first.
        const again = await send(body, 'prefill-key-061-a', etag);
        expect(again.status, JSON.stringify(again.json)).toBe(200);
        expect(again.json).toEqual(first.json);
        expect(await prefills(doc)).toHaveLength(1);
        // The same key with other values is not the same request: refused, nothing written.
        const other = await send({ values: { 'k.markup': 'Cy' } }, 'prefill-key-061-a', etag);
        expect(other.status).toBeGreaterThanOrEqual(400);
        expect(await prefills(doc)).toHaveLength(1);
        const read = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
        expect(read.json.values).toMatchObject({ 'k.markup': 'Ada', 'k.formula': 'Bea' });
      },
      60_000,
    );
  });
}
