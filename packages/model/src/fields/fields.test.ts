// The CDM side of fields (12 §3; FRW-001 to FRW-006) and the slots CDM 1 reserves for them
// (CDM-022): role placeholders, the form field atom, typed values and limits, the field
// invariants I13 to I15, and mirrors. The entry checks and presets of FRW-004 are the rules
// package's; the value type check here agrees with its `checkFieldValue`.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { checkFieldValue, compileDocument } from '../../../rules/src/index.ts';
import {
  addDefs,
  bodyOf,
  cell,
  codes,
  ctx,
  exampleDoc,
  footnote,
  invariants,
  para,
  row,
  sinkDoc,
  table,
  text,
  type Json,
} from '../../test/support.ts';
import { CDM1 } from '../definition/cdm1.ts';
import {
  FIELD_KINDS,
  FILLABLE_FIELD_KINDS,
  FORM_FIELD,
  ROLE_DEF,
  RULE_DEF,
  SERVER_SET_FIELD_KINDS,
} from '../definition/fields.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import { generateJsonSchema } from '../schema/json-schema.ts';
import { fieldText } from '../structure/field-text.ts';
import { readDocument } from '../validate/read.ts';
import { validate, validateDoc } from '../validate/validate.ts';
import { fieldValueProblem } from './values.ts';
const role = (id = 'role_tenant', attrs: Json = {}): Json => ({
  type: 'role_def',
  attrs: { id, name: 'Tenant', color: '#1F77B4', ...attrs },
});
const ff = (attrs: Json): Json => ({
  type: 'form_field',
  attrs: { id: 'ffField000000001', key: 'tenant.name', label: 'Name', ...attrs },
});
/** The example with `fields` required, a tenant role, and the given inline content in its last paragraph. */
function withFields(...content: Json[]): Json {
  const d = addDefs(exampleDoc(), role());
  d['requires'] = ['fields'];
  bodyOf(d)[2]!.content = content;
  return d;
}

describe('the slots CDM 1 reserves for fields and extensions (CDM-022)', () => {
  it('gives defs room for role_def* and rule_def*, and allows form_field wherever the body allows inline content', () => {
    expect(CDM1.nodes.find((n) => n.name === 'defs')!.content).toContain('role_def* rule_def*');
    expect(FORM_FIELD.group!.split(' ')).toEqual(
      expect.arrayContaining(['inline', 'caption_inline']),
    );
    const d = withFields(ff({}));
    bodyOf(d).push(
      table(
        'tTable0000000001',
        [1000],
        [
          row('rRow000000000001', [
            cell('cCell0000000000A', [
              para('pCell00000000001', [
                ff({ id: 'ffField000000002', key: 'tenant.city', label: 'City' }),
              ]),
            ]),
          ]),
        ],
      ),
    );
    expect(invariants(d)).toEqual([]);
  });

  it("imports the attributes of role_def, rule_def and form_field from FRW's definition module", () => {
    for (const n of [ROLE_DEF, RULE_DEF, FORM_FIELD]) expect(CDM1.nodes).toContain(n);
  });

  it('reports a role, a rule, a form field or a formValue field without `fields`, and an extension without `extensions` (I1)', () => {
    const noFeature = (f: (d: Json) => void): string[] => {
      const d = exampleDoc();
      f(d);
      return codes(d);
    };
    expect(noFeature((d) => addDefs(d, role()))).toEqual(['feature_missing']);
    expect(
      noFeature((d) => addDefs(d, { type: 'rule_def', attrs: { id: 'r1', when: {}, then: [] } })),
    ).toEqual(['feature_missing']);
    expect(noFeature((d) => (bodyOf(d)[2]!.content = [ff({})]))).toEqual(['feature_missing']);
    expect(
      noFeature(
        (d) =>
          (bodyOf(d)[2]!.content = [
            { type: 'field', attrs: { kind: 'formValue', target: 'field:a' } },
          ]),
      ),
    ).toContain('feature_missing');
    expect(
      noFeature(
        (d) =>
          (bodyOf(d)[2]!.content = [
            { type: 'extension_inline', attrs: { extension: 'com.example.x', fallbackText: 'x' } },
          ]),
      ),
    ).toEqual(['feature_missing']);
  });

  it('is refused by a reader that does not support `fields` (CDM-009), with a document holding a form field', () => {
    const d = withFields(ff({}));
    expect(readDocument(d, { features: ['extensions', 'preserve'] })).toMatchObject({
      ok: false,
      code: 'unsupported_feature',
      missing: ['fields'],
    });
    expect(readDocument(d).ok).toBe(true);
  });
});

describe('role placeholders (FRW-001)', () => {
  it('validates a role_def with id, name and color in defs, and nowhere else', () => {
    expect(invariants(withFields(text('x')))).toEqual([]);
    const inBody = withFields(text('x'));
    bodyOf(inBody).push(role('role_other'));
    expect(invariants(inBody)).toContain('I1');
  });

  it('refuses any other attribute, and declares the grammars of name and color in the published schema', () => {
    for (const extra of [{ user: 'u_481' }, { email: 'jane@example.org' }])
      expect(
        codes(addDefs(withFields(text('x')), role('role_landlord', extra))),
        JSON.stringify(extra),
      ).toEqual(['unknown_attribute']);
    expect(codes(addDefs(withFields(text('x')), role('role_landlord', { color: 'blue' })))).toEqual(
      ['attribute_invalid'],
    );
    expect(codes(addDefs(withFields(text('x')), role('role_landlord', { name: '' })))).toEqual([
      'attribute_invalid',
    ]);
    const schema = generateJsonSchema(CDM1)['$defs'] as Record<
      string,
      { properties: Record<string, Json>; additionalProperties: boolean }
    >;
    expect(schema['attrs.role_def']!.additionalProperties).toBe(false);
    expect(schema['attrs.role_def']!.properties['color']).toMatchObject({
      allOf: [{ pattern: '^#[0-9A-F]{6}$' }, expect.anything()],
    });
    expect(schema['attrs.role_def']!.properties['name']).toMatchObject({
      minLength: 1,
      maxLength: 255,
    });
  });

  it('matches a field to a role by id only, never by name or colour (I13)', () => {
    const d = withFields(ff({ assignee: 'Tenant' }));
    expect(codes(d)).toEqual(['unresolved_role']);
    bodyOf(d)[2]!.content[0].attrs.assignee = 'role_tenant';
    expect(invariants(d)).toEqual([]);
  });
});

describe('the form field atom (FRW-002)', () => {
  it('validates in a body paragraph and a table cell, and not in a header, footer or footnote (I10)', () => {
    expect(invariants(withFields(ff({})))).toEqual([]);
    for (const kind of ['header', 'footer']) {
      const d = withFields(text('x'));
      d['doc'].content.splice(1, 0, {
        type: 'story',
        attrs: { id: 'sStory0000000001', kind },
        content: [para('pStory0000000001', [ff({})])],
      });
      expect(codes(d), kind).toEqual(['form_field_placement']);
    }
    expect(
      codes(withFields(footnote('fnNote0000000001', [para('pNote00000000001', [ff({})])]))),
    ).toEqual(['form_field_placement']);
  });

  it('declares every attribute with a grammar, and accepts exactly the nine kinds of version 1', () => {
    const names = [
      'id',
      'key',
      'kind',
      'label',
      'assignee',
      'required',
      'readOnly',
      'value',
      'default',
      'placeholder',
      'options',
      'format',
      'validation',
      'width',
      'sensitive',
    ];
    expect(Object.keys(FORM_FIELD.attrs)).toEqual([...names, 'ext']);
    const schema = generateJsonSchema(CDM1)['$defs'] as Record<
      string,
      { properties: Record<string, Json> }
    >;
    for (const n of names) expect(schema['attrs.form_field']!.properties, n).toHaveProperty(n);
    expect(schema['attrs.form_field']!.properties['kind']).toMatchObject({
      enum: [...FIELD_KINDS],
    });
    expect([...FIELD_KINDS]).toEqual([
      'text',
      'number',
      'date',
      'checkbox',
      'choice',
      'signature',
      'initials',
      'dateSigned',
      'formula',
    ]);
    for (const kind of FIELD_KINDS)
      expect(
        invariants(
          withFields(
            ff({ kind, ...(kind === 'choice' ? { options: [{ id: 'a', label: 'A' }] } : {}) }),
          ),
        ),
        kind,
      ).toEqual([]);
    expect(codes(withFields(ff({ kind: 'attachment' })))).toEqual(['attribute_invalid']);
  });

  it('defaults id to null in the editing schema, so ProseMirror can create the field', () => {
    const node = cdmSchema().nodes['form_field']!.create({ key: 'a', label: 'A' });
    expect(node.attrs['id']).toBeNull();
  });

  it('gives each choice option an id and a label, unique within the field (I11)', () => {
    expect(
      invariants(
        withFields(
          ff({
            kind: 'choice',
            options: [
              { id: 'single', label: 'Single' },
              { id: 'married', label: 'Married' },
            ],
          }),
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        withFields(
          ff({
            kind: 'choice',
            options: [
              { id: 'a', label: 'A' },
              { id: 'a', label: 'B' },
            ],
          }),
        ),
      ),
    ).toEqual(['duplicate_option_id']);
    expect(codes(withFields(ff({ kind: 'choice', options: [{ id: 'a' }] })))).toEqual([
      'attribute_invalid',
    ]);
  });

  it('takes width as a length in twips', () => {
    expect(invariants(withFields(ff({ width: 1920 })))).toEqual([]);
    for (const width of [-1, 1920.5, '1920', 40000])
      expect(invariants(withFields(ff({ width }))), String(width)).toContain('I11');
  });
});

describe('typed, limited field values (FRW-003)', () => {
  it('refuses a text value longer than 4 KiB (I15)', () => {
    expect(invariants(withFields(ff({ value: 'é'.repeat(2048) })))).toEqual([]);
    expect(codes(withFields(ff({ value: 'é'.repeat(2049) })))).toEqual(['value_too_large']);
    expect(codes(withFields(ff({ value: 'a'.repeat(4097) })))).toEqual(['value_too_large']);
  });

  it('accepts a number as a decimal string as written, and refuses JSON numbers and other forms', () => {
    for (const value of ['12.50', '0', '-3', '1000000.01'])
      expect(invariants(withFields(ff({ kind: 'number', value }))), value).toEqual([]);
    // A JSON number, a float included, is a value of the wrong type for its kind (I15), never an
    // I11 grammar problem, so that a fill commit gets `field_invalid` (12 §4.2, P7).
    for (const value of [12.5, 12, '12,50', '1e3', '+1', '.5', '012']) {
      const v = validate(withFields(ff({ kind: 'number', value })), ctx).violations;
      expect(
        v.map((x) => [x.invariant, x.code]),
        String(value),
      ).toEqual([['I15', 'value_type']]);
    }
    expect(fieldValueProblem('number', '12.50')).toBeNull();
  });

  it('types date, checkbox and choice values', () => {
    expect(invariants(withFields(ff({ kind: 'date', value: '2024-02-29' })))).toEqual([]);
    for (const value of ['2023-02-29', '2026-11-06T10:00:00Z', '06/11/2026', '2026-13-01'])
      expect(codes(withFields(ff({ kind: 'date', value }))), value).toEqual(['value_type']);
    expect(invariants(withFields(ff({ kind: 'checkbox', value: true })))).toEqual([]);
    expect(codes(withFields(ff({ kind: 'checkbox', value: 'true' })))).toEqual(['value_type']);
    const choice = (value: string) =>
      ff({ kind: 'choice', options: [{ id: 'married', label: 'Married' }], value });
    expect(invariants(withFields(choice('married')))).toEqual([]);
    expect(codes(withFields(choice('Married')))).toEqual(['value_type']);
  });

  it('shapes signature and initials as { asset, mode } with an attached asset, dateSigned as a date and formula as a string; null is empty', () => {
    const ASSET = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
    for (const kind of ['signature', 'initials']) {
      for (const mode of ['typed', 'drawn', 'uploaded'])
        expect(
          invariants(withFields(ff({ kind, value: { asset: ASSET, mode } }))),
          `${kind} ${mode}`,
        ).toEqual([]);
      for (const value of [
        { asset: ASSET, mode: 'stamped' },
        { asset: 'not-a-uuid', mode: 'typed' },
        { asset: ASSET },
        { asset: ASSET, mode: 'typed', at: 1 },
        'Jane',
      ])
        expect(codes(withFields(ff({ kind, value }))), JSON.stringify(value)).toEqual([
          'value_type',
        ]);
      expect(
        codes(
          withFields(
            ff({ kind, value: { asset: '0192f0c4-7b1e-7c3a-9a54-0000000000ab', mode: 'typed' } }),
          ),
        ),
        kind,
      ).toEqual(['asset_not_attached']);
    }
    expect(invariants(withFields(ff({ kind: 'dateSigned', value: '2026-11-06' })))).toEqual([]);
    expect(codes(withFields(ff({ kind: 'dateSigned', value: '2026-11-06T10:00:00Z' })))).toEqual([
      'value_type',
    ]);
    for (const value of ['1250.00', 'Approved'])
      expect(invariants(withFields(ff({ kind: 'formula', value }))), value).toEqual([]);
    for (const kind of FIELD_KINDS)
      expect(
        invariants(
          withFields(
            ff({
              kind,
              value: null,
              ...(kind === 'choice' ? { options: [{ id: 'a', label: 'A' }] } : {}),
            }),
          ),
        ),
        kind,
      ).toEqual([]);
  });

  it('reports a wrongly typed value under I15 at the path of the value, which the authority maps to field_invalid', () => {
    const v = validate(withFields(ff({ kind: 'number', value: 'twelve' })), ctx).violations;
    expect(v).toEqual([
      expect.objectContaining({ invariant: 'I15', code: 'value_type', nodeId: 'ffField000000001' }),
    ]);
    expect(v[0]!.path.endsWith('/value')).toBe(true);
  });
});

describe('one verdict with the rules package (FRW-003; ADR 0030 §6)', () => {
  it('agrees with @docedit/rules on the type of a value for every kind', () => {
    const ASSET = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
    const values: Json[string][] = [
      null,
      'Ada',
      '',
      'a\u0007b',
      'x'.repeat(4096),
      'x'.repeat(4097),
      '12.50',
      '1'.repeat(64),
      '1'.repeat(65),
      12.5,
      12,
      true,
      '0001-01-01',
      '0099-12-31',
      '2024-02-29',
      '2023-02-29',
      'a',
      { asset: ASSET, mode: 'typed' },
      { asset: ASSET, mode: 'carved' },
    ];
    for (const kind of FIELD_KINDS)
      for (const value of values) {
        const options = [{ id: 'a', label: 'A' }];
        const model = fieldValueProblem(kind, value, { options }) === null;
        const rules = checkFieldValue({ kind, options: ['a'] }, value) === null;
        expect(model, `${kind} ${JSON.stringify(value)?.slice(0, 30)}`).toBe(rules);
      }
  });

  it('holds in the kitchen-sink fixture a rule that the rules package compiles', () => {
    const r = compileDocument(sinkDoc());
    expect(r.ok ? [] : r.problems).toEqual([]);
  });
});
describe('the field invariants of the document model (FRW-005)', () => {
  it('refuses two form fields with the same key (I13)', () => {
    const d = withFields(ff({}), ff({ id: 'ffField000000002' }));
    expect(codes(d)).toEqual(['duplicate_field_key']);
    expect(invariants(d)).toEqual(['I13']);
  });

  it('refuses an assignee that names no role, and deleting a role still assigned (I13)', () => {
    expect(codes(withFields(ff({ assignee: 'role_landlord' })))).toEqual(['unresolved_role']);
    const d = withFields(ff({ assignee: 'role_tenant' }));
    expect(invariants(d)).toEqual([]);
    const list = d['doc'].content[0].content as Json[];
    list.splice(
      list.findIndex((n) => n.type === 'role_def'),
      1,
    );
    expect(codes(d)).toEqual(['unresolved_role']);
  });

  it('refuses a formValue whose target is no field key, and deleting the field it mirrors (I14)', () => {
    const mirror = { type: 'field', attrs: { kind: 'formValue', target: 'field:tenant.name' } };
    expect(invariants(withFields(ff({}), mirror))).toEqual([]);
    const missing = withFields(mirror);
    expect(codes(missing)).toEqual(['unresolved_field_key']);
    expect(invariants(missing)).toEqual(['I14']);
  });

  it('refuses more than 2,000 fields (I15)', () => {
    const fields = (n: number) =>
      withFields(
        ...Array.from({ length: n }, (_, i) =>
          ff({ id: `ff${String(i).padStart(14, '0')}`, key: `k${i}` }),
        ),
      );
    expect(invariants(fields(2000))).toEqual([]);
    expect(codes(fields(2001))).toEqual(['too_many_fields']);
  });

  it('checks the result of a commit made only of value attribute steps', () => {
    const doc = cdmSchema().nodeFromJSON(withFields(ff({ kind: 'number' }))['doc']);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.type.name === 'form_field') pos = p;
      return pos < 0;
    });
    const r = new AttrStep(pos, 'value', '12,50').apply(doc);
    expect(validateDoc(r.doc!, ['fields'], ctx).violations.map((v) => v.code)).toEqual([
      'value_type',
    ]);
  });
});

describe('mirrors of a field value (FRW-006)', () => {
  it('prints the value of the target field, and nothing when it is empty', () => {
    const mirror = { kind: 'formValue', target: 'field:tenant.name' };
    const fields = (value: Json[string]) => new Map([['tenant.name', { kind: 'text', value }]]);
    expect(fieldText(mirror, { fields: fields('Ada Lovelace') })).toEqual({
      computed: true,
      text: 'Ada Lovelace',
    });
    expect(fieldText(mirror, { fields: fields(null) })).toEqual({ computed: true, text: '' });
    const choice = new Map([
      [
        'tenant.status',
        { kind: 'choice', value: 'married', options: [{ id: 'married', label: 'Married' }] },
      ],
    ]);
    expect(
      fieldText({ kind: 'formValue', target: 'field:tenant.status' }, { fields: choice }),
    ).toEqual({ computed: true, text: 'Married' });
  });

  it('makes a document whose mirror targets no field invalid (FRW-005)', () => {
    expect(
      invariants(
        withFields({ type: 'field', attrs: { kind: 'formValue', target: 'field:nobody' } }),
      ),
    ).toEqual(['I14']);
  });

  it('keeps the kinds a participant fills apart from those only the server sets (12 §4.2)', () => {
    expect([...FILLABLE_FIELD_KINDS]).toEqual(['text', 'number', 'date', 'checkbox', 'choice']);
    expect([...SERVER_SET_FIELD_KINDS]).toEqual(['signature', 'initials', 'dateSigned', 'formula']);
  });
});
