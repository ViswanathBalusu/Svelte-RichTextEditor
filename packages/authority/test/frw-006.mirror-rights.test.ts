// A mirror of a field's value (12 §3.4; FRW-006 criterion 2): a participant with only `fill` may
// change the `value` of their own form fields and nothing else, so a change to a `field` node of
// kind `formValue` (the mirror, or its cached text) is refused. The other criteria of FRW-006 are
// the editor's, the PDF writer's, and are not tested here.
import type { Node } from 'prosemirror-model';
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { posOf } from './fixtures.ts';
import { FIELDS, USERS, fieldsJson, refused, schema, verdictOf } from './permission-fixtures.ts';

type J = Record<string, unknown>;

/** The fixture with one mirror of the tenant's amount in the fields paragraph. */
function mirrorDoc(): Node {
  const json = fieldsJson() as unknown as { content: Array<{ content: J[] }> };
  const body = json.content[1]!.content;
  const para = body.find((b) => (b['attrs'] as J | undefined)?.['id'] === 'pFields00000001X')!;
  (para['content'] as J[]).push({
    type: 'field',
    attrs: { kind: 'formValue', target: 'tenant.amount', format: null },
  });
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

/** The position of the mirror, the only `field` node of the fixture (it carries no `id`). */
function mirrorPos(doc: Node): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.type.name === 'field') found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error('no mirror in the fixture');
  return found;
}

const setMirrorAttr = (attr: string, value: unknown) => (doc: Node) => [
  new AttrStep(mirrorPos(doc), attr, value),
];
const setValue = (id: string, value: unknown) => (doc: Node) => [
  new AttrStep(posOf(doc, id), 'value', value),
];

describe('FRW-006 a fill-only participant changes no mirror (criterion 2)', () => {
  it('refuses a change to the cached text of a mirror, with the body scope named', () => {
    const verdict = verdictOf(USERS.erin, mirrorDoc(), setMirrorAttr('cached', '999.00'));
    expect(verdict.ok).toBe(false);
    expect(refused(verdict)).toContain('body');
  });

  it('refuses a change to the target of a mirror by a participant with only fill', () => {
    const verdict = verdictOf(USERS.erin, mirrorDoc(), setMirrorAttr('target', 'landlord.name'));
    expect(verdict.ok).toBe(false);
  });

  it('still accepts the fill of the field itself by the same participant (control)', () => {
    expect(verdictOf(USERS.erin, mirrorDoc(), setValue(FIELDS.number, '12.50')).ok).toBe(true);
  });
});
