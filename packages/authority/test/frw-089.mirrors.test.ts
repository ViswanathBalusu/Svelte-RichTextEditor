// A mirror of a value a reader may not read carries no text for that reader (FRW-089 criterion 1:
// mirrors and `cached` text). The hidden set names the keys of the values the reader cannot read:
// those marked sensitive, those inside a hidden region and those the rules compute from them. A
// `formValue` field that points at one of them has no `cached` text in the reader's projection,
// whether it comes in the document or in a commit. A `styleRef` keeps none while a region is hidden.
// A reader with access, and a mirror of a value the reader can read, are the controls.
import type { Node } from 'prosemirror-model';
import { AttrStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { hiddenSet } from '../src/permissions/visibility.ts';
import { project, projectCommit, projectionSchema } from '../src/projection/projection.ts';
import { BASE_JSON, USERS, basePermissions, schema } from './fixtures.ts';

const NOW = 1_760_000_000_000;

type J = Record<string, unknown>;

const field = (id: string, key: string, extra: J = {}): J => ({
  type: 'form_field',
  attrs: {
    id,
    key,
    kind: 'text',
    label: key,
    assignee: 'role_tenant',
    value: 'v-' + key,
    ...extra,
  },
});

const mirror = (key: string, cached: string): J => ({
  type: 'field',
  attrs: { kind: 'formValue', target: `field:${key}`, cached },
});

/** The base document plus a paragraph holding fields, their mirrors and a style reference. */
function document(): Node {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  // The legal region is confidential: only the principals with a grant read it (ADR 0019).
  for (const block of json.content[1]!.content)
    if (block['type'] === 'region' && (block['attrs'] as J)['id'] === 'rLegal000000000B')
      (block['attrs'] as J)['policy'] = 'confidential';
  json.content[0]!.content.push({
    type: 'rule_def',
    attrs: {
      id: 'r_total',
      when: true,
      then: [{ set: { field: 'total', value: { sum: [{ field: 'income' }, '1'] } } }],
    },
  });
  json.content[1]!.content.splice(1, 0, {
    type: 'paragraph',
    attrs: { id: 'pMirrors0000001X' },
    content: [
      field('fIncome000000001', 'income', { kind: 'number', sensitive: true, value: '4711' }),
      field('fTotal0000000001', 'total', { kind: 'formula', value: '4712' }),
      field('fPlain000000001X', 'plain', { value: 'open' }),
      mirror('income', '4711'),
      mirror('total', '4712'),
      mirror('plain', 'open'),
      mirror('tenant.name', 'Ada'),
      { type: 'field', attrs: { kind: 'styleRef', target: 'style:Heading1', cached: 'Lease' } },
      { type: 'field', attrs: { kind: 'ref', target: 'node:pLegal000000001B', cached: '4.2' } },
      { type: 'field', attrs: { kind: 'ref', target: 'node:pIntro0000000001', cached: '1.1' } },
    ],
  });
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

type Conn = (typeof USERS)[keyof typeof USERS];

/** The `cached` text of each field node a reader's projection holds, by its target. */
function cachedFor(doc: Node, conn: Conn): Record<string, unknown> {
  const hidden = hiddenSet(conn, doc, basePermissions(), NOW);
  const out: Record<string, unknown> = {};
  project(doc, hidden, projectionSchema()).doc.descendants((n) => {
    if (n.type.name === 'field') out[String(n.attrs['target'])] = n.attrs['cached'] ?? null;
    return true;
  });
  return out;
}

describe('a mirror of a value the reader cannot read has no text (FRW-089 criterion 1)', () => {
  it('blanks the mirror of a sensitive value, of a value derived from it and of a value in a hidden region', () => {
    const cached = cachedFor(document(), USERS.frank);
    expect(cached['field:income']).toBeNull();
    expect(cached['field:total']).toBeNull();
    expect(cached['field:tenant.name']).toBeNull();
  });

  it('keeps the text of a mirror of a value the reader may read (control)', () => {
    expect(cachedFor(document(), USERS.frank)['field:plain']).toBe('open');
  });

  it('keeps every text for a reader who reads everything (control)', () => {
    expect(cachedFor(document(), USERS.alice)).toMatchObject({
      'field:income': '4711',
      'field:total': '4712',
      'field:plain': 'open',
      'field:tenant.name': 'Ada',
      'style:Heading1': 'Lease',
    });
  });

  it('shows the text of a mirror of a value in a region the reader holds a grant on (control)', () => {
    // Bob's group has a grant on the legal region, so its fields are his to read.
    expect(cachedFor(document(), USERS.bob)['field:tenant.name']).toBe('Ada');
  });

  it('blanks the text of a style reference while a region is hidden from the reader', () => {
    expect(cachedFor(document(), USERS.frank)['style:Heading1']).toBeNull();
    // Bob reads every region, so nothing is hidden from him.
    expect(cachedFor(document(), USERS.bob)['style:Heading1']).toBe('Lease');
  });

  it('blanks the text of a reference to something in a hidden region and keeps the others', () => {
    const frank = cachedFor(document(), USERS.frank);
    expect(frank['node:pLegal000000001B']).toBeNull();
    // A reference to a block the reader can see keeps its number (owner decision 11).
    expect(frank['node:pIntro0000000001']).toBe('1.1');
    expect(cachedFor(document(), USERS.bob)['node:pLegal000000001B']).toBe('4.2');
  });

  it('does not change what the full document holds', () => {
    const doc = document();
    cachedFor(doc, USERS.frank);
    let held: unknown = null;
    doc.descendants((n) => {
      if (n.type.name === 'field' && n.attrs['target'] === 'field:income') held = n.attrs['cached'];
      return true;
    });
    expect(held).toBe('4711');
  });
});

describe('a commit that writes the text of a mirror does not carry it to a reader who may not read it', () => {
  function setCached(doc: Node, target: string, text: string): { step: Step; after: Node } {
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.type.name === 'field' && n.attrs['target'] === target) pos = p;
      return pos < 0;
    });
    const step = new AttrStep(pos, 'cached', text);
    return { step, after: step.apply(doc).doc! };
  }

  it('sends the reader no step that holds the new text, and the result is the projection of the new document', () => {
    const doc = document();
    const { step, after } = setCached(doc, 'field:income', '9999');
    const frank = hiddenSet(USERS.frank, doc, basePermissions(), NOW);
    const before = project(doc, frank, projectionSchema());
    const sent = projectCommit(before, doc, [step], frank);
    expect(JSON.stringify(sent.steps.map((s) => s.toJSON()))).not.toContain('9999');
    let view = before.doc;
    for (const s of sent.steps) view = s.apply(view).doc!;
    expect(view.eq(project(after, frank, projectionSchema()).doc)).toBe(true);
  });

  it('sends the text to a reader who may read the value (control)', () => {
    const doc = document();
    const { step } = setCached(doc, 'field:plain', '9999');
    const frank = hiddenSet(USERS.frank, doc, basePermissions(), NOW);
    const before = project(doc, frank, projectionSchema());
    const sent = projectCommit(before, doc, [step], frank);
    expect(JSON.stringify(sent.steps.map((s) => s.toJSON()))).toContain('9999');
  });
});
