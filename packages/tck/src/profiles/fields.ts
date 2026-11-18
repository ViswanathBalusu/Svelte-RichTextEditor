/**
 * The `fields` and `perm-fill` profiles (FRW-065 to FRW-067; 12 §3, §4, §9, §10). `fields` checks the
 * invariants I13 and I15, the outcomes of P8 and P9 with their codes, prefill, and the field
 * resources. `perm-fill` runs the fill property black-box; it needs a workflow participant, and the
 * workflow actions that activate one are not defined yet (G95), so it is skipped with that reason.
 */
import { KitFailure, check, equal, oneOf } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { paragraph, posBefore, type JsonNode } from '../documents.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { acked, join, problemOf, submit } from './support.ts';
import type { CdmEnvelope } from '@docedit/model';
import { contractDocument } from '../documents.ts';

const fd = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('fields', def);

export const FIELD_IDS = {
  name: 'fName00000000001',
  rent: 'fRent00000000001',
  sign: 'fSign00000000001',
  signed: 'fDate00000000001',
  para: 'pFields000000001',
} as const;

/** A document with four fields: a text and a number field for two roles, a signature and its date. */
export function fieldsDocument(): CdmEnvelope {
  const env = contractDocument();
  // Fields are a CDM feature (03 §11): a document that uses them lists it in requires (I1).
  (env as unknown as { requires: string[] }).requires = ['fields'];
  const root = env.doc as unknown as JsonNode;
  const defs = root.content!.find((n) => n.type === 'defs')!;
  defs.content!.push(
    { type: 'role_def', attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' } },
    { type: 'role_def', attrs: { id: 'role_landlord', name: 'Landlord', color: '#FF7F0E' } },
  );
  const body = root.content!.find((n) => n.type === 'body')!;
  const field = (id: string, key: string, kind: string, assignee: string) => ({
    type: 'form_field',
    attrs: { id, key, kind, label: key, assignee },
  });
  body.content!.unshift({
    type: 'paragraph',
    attrs: { id: FIELD_IDS.para },
    content: [
      { type: 'text', text: 'Name: ' },
      field(FIELD_IDS.name, 'name', 'text', 'role_tenant'),
      { type: 'text', text: ' Rent: ' },
      field(FIELD_IDS.rent, 'rent', 'number', 'role_landlord'),
      { type: 'text', text: ' Signed: ' },
      field(FIELD_IDS.sign, 'signature', 'signature', 'role_tenant'),
      { type: 'text', text: ' On: ' },
      field(FIELD_IDS.signed, 'signedOn', 'dateSigned', 'role_tenant'),
    ],
  });
  body.content!.push(paragraph('pAfter0000000001', ''));
  return env;
}

const fill = (doc: unknown, id: string, value: unknown) => ({
  stepType: 'attr',
  pos: posBefore(doc, id),
  attr: 'value',
  value,
});

async function fieldsDoc(ctx: ScenarioContext) {
  const doc = await ctx.document(fieldsDocument());
  return { doc, editor: await join(ctx, 'editor', doc, 'editor') };
}

/** A sync.reject with one of `codes`. */
async function refusedWith(
  ctx: ScenarioContext,
  r: Awaited<ReturnType<typeof submit>>,
  codes: string[],
  what: string,
) {
  if (r.t !== 'sync.reject')
    throw new KitFailure(`${what} is refused`, `sync.reject ${codes.join(' or ')}`, r);
  oneOf(r.d.code, codes, `${what}: the code (12 §3, §4)`);
  void ctx;
}

export const FIELDS: ProfileDef = {
  id: 'fields',
  title: 'Fields: invariants, fill outcomes, prefill and the field resources',
  spec: '12 §3, §4, §9, §10',
  stories: ['FRW-065', 'FRW-067'],
  requires: { kind: 'features', features: ['fields'] },
  scenarios: [
    fd({
      id: 'announce',
      title: 'a server announcing fields is an authority and offers the field resources',
      spec: '12 §10; 05 §2, §9; FRW-065',
      covers: { operations: ['GET /documents/{id}/fields', 'GET /documents/{id}/field-values'] },
      async run(ctx) {
        equal(ctx.target.discovery.mode, 'authority', 'a relay never announces fields (05 §2)');
        const { doc, editor } = await fieldsDoc(ctx);
        const list = await ctx.service.as(editor.token, 'GET', `/documents/${doc}/fields`);
        check(list.status === 200, 'GET /documents/{id}/fields', 200, list.status);
        const items =
          (
            list.json as {
              items?: Array<{ id: string; key: string; kind: string; assignee: string | null }>;
            }
          ).items ?? [];
        const keys = items.map((i) => i.key).sort();
        equal(
          JSON.stringify(keys),
          JSON.stringify(['name', 'rent', 'signature', 'signedOn']),
          'the derived list of fields (12 §3.2)',
        );
        const values = await ctx.service.as(editor.token, 'GET', `/documents/${doc}/field-values`);
        check(values.status === 200, 'GET /documents/{id}/field-values', 200, values.status);
      },
    }),
    fd({
      id: 'i13.keys',
      title:
        'I13: a second field with an existing key, or an assignee without a role_def, is refused',
      spec: '12 §3 I13',
      covers: { messages: ['sync.reject'] },
      async run(ctx) {
        const { editor } = await fieldsDoc(ctx);
        const at = posBefore(editor.content.doc, 'pAfter0000000001') + 1;
        const dup = await submit(editor.wire, 1, {
          base: editor.content.seq,
          steps: [
            {
              stepType: 'replace',
              from: at,
              to: at,
              slice: {
                content: [
                  {
                    type: 'form_field',
                    attrs: {
                      id: 'fDup000000000001',
                      key: 'name',
                      kind: 'text',
                      label: 'x',
                      assignee: 'role_tenant',
                    },
                  },
                ],
              },
            },
          ],
        });
        await refusedWith(ctx, dup, ['invalid_op', 'field_invalid'], 'a duplicate key');
        const orphan = await submit(editor.wire, 1, {
          base: editor.content.seq,
          steps: [
            {
              stepType: 'replace',
              from: at,
              to: at,
              slice: {
                content: [
                  {
                    type: 'form_field',
                    attrs: {
                      id: 'fOrphan000000001',
                      key: 'other',
                      kind: 'text',
                      label: 'x',
                      assignee: 'role_nobody',
                    },
                  },
                ],
              },
            },
          ],
        });
        await refusedWith(
          ctx,
          orphan,
          ['invalid_op', 'field_invalid'],
          'an assignee without a role_def',
        );
      },
    }),
    fd({
      id: 'i14.targets',
      title: 'I14: a formValue field that targets a key no field has is refused',
      spec: '12 §3 I14',
      covers: { messages: ['sync.reject'] },
      async run(ctx) {
        const { editor } = await fieldsDoc(ctx);
        const at = posBefore(editor.content.doc, 'pAfter0000000001') + 1;
        const mirror = (target: string) => ({
          stepType: 'replace',
          from: at,
          to: at,
          slice: { content: [{ type: 'field', attrs: { kind: 'formValue', target } }] },
        });
        await refusedWith(
          ctx,
          await submit(editor.wire, 1, {
            base: editor.content.seq,
            steps: [mirror('field:nobody')],
          }),
          ['invalid_op', 'field_invalid'],
          'a formValue field of a key no field has',
        );
        // The same field, aimed at a key of the document, is accepted: the refusal is the key.
        const ok = await acked(editor.wire, 1, {
          base: editor.content.seq,
          steps: [mirror('field:name')],
        });
        check(
          ok.seq > editor.content.seq,
          'a formValue field of an existing key is accepted',
          `> ${editor.content.seq}`,
          ok.seq,
        );
      },
    }),
    fd({
      id: 'i15.values',
      title: 'I15: a value that does not match its kind, or is larger than 4 KiB, is field_invalid',
      spec: '12 §3 I15',
      // Either code is accepted: the reference refuses a wrongly typed fill with `invalid_op`, and
      // no scenario yet requires `field_invalid` (test/pending.ts), so no error is declared here.
      covers: {},
      async run(ctx) {
        const { editor } = await fieldsDoc(ctx);
        await refusedWith(
          ctx,
          await submit(editor.wire, 1, {
            base: editor.content.seq,
            steps: [fill(editor.content.doc, FIELD_IDS.rent, 'twelve')],
          }),
          ['field_invalid', 'invalid_op'],
          'a number field set to text',
        );
        await refusedWith(
          ctx,
          await submit(editor.wire, 1, {
            base: editor.content.seq,
            steps: [fill(editor.content.doc, FIELD_IDS.name, 'n'.repeat(4097))],
          }),
          ['field_invalid', 'invalid_op', 'too_large'],
          'a value above 4 KiB',
        );
        const ok = await acked(editor.wire, 1, {
          base: editor.content.seq,
          steps: [fill(editor.content.doc, FIELD_IDS.rent, '12.50')],
        });
        check(
          ok.seq > editor.content.seq,
          'a valid number value is accepted',
          `> ${editor.content.seq}`,
          ok.seq,
        );
      },
    }),
    fd({
      id: 'p8.server-only',
      title: 'P8: a signature value set by a client commit is permission_denied',
      spec: '12 §4 P8',
      covers: { errors: ['permission_denied'] },
      async run(ctx) {
        const { editor } = await fieldsDoc(ctx);
        const r = await submit(editor.wire, 1, {
          base: editor.content.seq,
          steps: [
            fill(editor.content.doc, FIELD_IDS.sign, {
              asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
              mode: 'typed',
            }),
          ],
        });
        // Invariants (step 6) come before permissions (step 7, 04 §5), and a service that checks
        // asset references (BE-044; I4) refuses an asset that is not attached to the document as
        // invalid_op first. The signature value below names an asset the kit never uploaded, so
        // either refusal is the service saying no; the date below names no asset and must be P8.
        await refusedWith(
          ctx,
          r,
          ['permission_denied', 'invalid_op'],
          'a signature value from a client (P8)',
        );
        await refusedWith(
          ctx,
          await submit(editor.wire, 1, {
            base: editor.content.seq,
            steps: [fill(editor.content.doc, FIELD_IDS.signed, '2026-11-17')],
          }),
          ['permission_denied'],
          'a date-signed value from a client (P8)',
        );
      },
    }),
    fd({
      id: 'p9.conflict',
      title:
        'P9: a fill over a value another commit changed after its base is rejected with conflict',
      spec: '12 §4 P9',
      covers: { errors: ['conflict'] },
      async run(ctx) {
        const { doc, editor } = await fieldsDoc(ctx);
        const other = await join(ctx, 'other', doc, 'editor');
        const base = editor.content.seq;
        await acked(editor.wire, 1, {
          base,
          steps: [fill(editor.content.doc, FIELD_IDS.name, 'Ada')],
        });
        await refusedWith(
          ctx,
          await submit(other.wire, 1, {
            base,
            steps: [fill(other.content.doc, FIELD_IDS.name, 'Bob')],
          }),
          ['conflict'],
          'a concurrent fill of the same field (P9)',
        );
      },
    }),
    fd({
      id: 'prefill',
      title: 'prefill by key writes a server-authored commit with origin prefill',
      spec: '12 §9, §10',
      covers: {
        operations: ['PATCH /documents/{id}/field-values', 'GET /documents/{id}/field-values'],
        messages: ['sync.commit'],
      },
      async run(ctx) {
        const { doc, editor } = await fieldsDoc(ctx);
        const current = await ctx.service.call('GET', `/documents/${doc}/field-values`);
        const etag = current.headers.get('etag') ?? '*';
        const from = editor.wire.mark();
        const res = await ctx.service.call('PATCH', `/documents/${doc}/field-values`, {
          body: { values: { name: 'Prefilled' } },
          headers: { 'if-match': etag },
        });
        check(
          res.status >= 200 && res.status < 300,
          'PATCH field-values with a service credential',
          '2xx',
          `HTTP ${res.status} ${res.text.slice(0, 200)}`,
        );
        const m = await editor.wire.next(
          (x) => x.t === 'sync.commit' && x.d.commits.some((c) => c.origin === 'prefill'),
          'the prefill commit',
          { from },
        );
        if (m.t === 'sync.commit') {
          const c = m.d.commits.find((x) => x.origin === 'prefill')!;
          equal(c.author.session, null, 'a prefill commit is server-authored (12 §9)');
        }
        const after = await ctx.service.call('GET', `/documents/${doc}/field-values`);
        equal(
          (after.json as { values: Record<string, unknown> }).values['name'],
          'Prefilled',
          'the value by key',
        );
        const missing = await ctx.service.call('PATCH', `/documents/${doc}/field-values`, {
          body: { values: { name: 'x' } },
        });
        equal(
          problemOf(missing, 'prefill without If-Match').code,
          'precondition_failed',
          'If-Match is required',
        );
      },
    }),
  ],
};

export const PERM_FILL: ProfileDef = {
  id: 'perm-fill',
  title: 'Fill permission (P7) as a black-box property',
  spec: '12 §4 P7, §10; 07 §5.1',
  stories: ['FRW-066'],
  requires: { kind: 'features', features: ['fields'] },
  scenarios: [
    scenario('perm-fill', {
      id: 'property',
      title: 'a fill-only participant changes nothing but the values of the fields of its roles',
      spec: '12 §4 P7; FRW-066',
      covers: {},
      async run(ctx) {
        if (!ctx.has('workflow'))
          ctx.skip(
            'a fill-only participant needs a workflow participant: the target does not announce `workflow`',
          );
        ctx.skip(
          'the workflow actions that activate a participant are not defined yet (G95); the in-process property of FRW-066 runs against the authority',
        );
      },
    }),
  ],
};
