/**
 * FRW-076 criterion 1 in the editing core, in Node.js (lane V-FRW-073-089, round 3): under a
 * participant's fill-only access the body is read-only, and a form field's value changes only when
 * the field is assigned to one of the participant's roles, the participant is active and the field
 * is not static read-only (12 §4.2, rule P7). The authority remains the boundary; this is the
 * local refusal that keeps a person from meeting a rejection.
 *
 * The region guard is tested directly (`checkChange`), because the core locks every local change
 * in the `fill` mode (mode.ts, `modeLocks`): the field fill path of the core is not built yet.
 */
import type { Access } from '@docedit/protocol';
import { TextSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { checkChange } from './guard.ts';
import { DocumentCore } from './core.ts';
import { SPIKE_IDS, spikeDocument } from './spike-document.ts';
import { internals } from './testing.ts';

const microtask = (run: () => void) => queueMicrotask(run);

const EDITOR_CAPS = ['view', 'comment', 'suggest', 'edit'] as Access['caps'];

/** An author's access, under which the fields are inserted. */
function editorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: EDITOR_CAPS,
    scopes: {
      doc: ['view'],
      body: EDITOR_CAPS,
      defs: ['view'],
      [`story:${SPIKE_IDS.header}`]: ['view'],
    } as Access['scopes'],
    leases: {},
    fill: null,
    restrictions: [],
  } as Access;
}

/** A participant who may only fill, holding `roles`. */
function participantAccess(roles: string[], active = true): Access {
  return {
    rev: 2,
    asOfSeq: 0,
    docRole: 'editor',
    caps: ['view', 'fill'] as Access['caps'],
    scopes: {
      doc: ['view'],
      body: ['view', 'fill'],
      defs: ['view'],
      [`story:${SPIKE_IDS.header}`]: ['view'],
    } as Access['scopes'],
    leases: {},
    fill: { participant: 'wfp-frw-076', roles, active },
    restrictions: [],
  } as Access;
}

function core(): DocumentCore {
  const doc = spikeDocument();
  doc.requires = ['fields'];
  return new DocumentCore({ doc, access: editorAccess(), schedule: microtask });
}

/** Inserts a paragraph with a tenant field and a landlord field after the body paragraph. */
function insertFields(c: DocumentCore): void {
  const i = internals(c);
  let pos = -1;
  i.state.doc.descendants((node, p) => {
    if (pos < 0 && node.attrs['id'] === SPIKE_IDS.after) pos = p;
    return pos < 0;
  });
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos + 1)));
  const field = (assignee: string, key: string) => ({
    type: 'form_field',
    attrs: { id: null, key, kind: 'text', label: key, assignee, value: null },
  });
  const result = c.insertContent({
    cdm: 1,
    requires: ['fields'],
    defs: [],
    openStart: 0,
    openEnd: 0,
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'pFrw076fields001', style: 'Normal' },
        content: [
          field('tenant', 'tenant.name'),
          { type: 'text', text: ' ' },
          field('landlord', 'landlord.name'),
        ],
      },
    ],
  } as unknown as Parameters<DocumentCore['insertContent']>[0]);
  if (!result.ok) throw new Error('the fields were not inserted');
}

/** The position of the form field assigned to `assignee`, or -1. */
function fieldPos(c: DocumentCore, assignee: string): number {
  let pos = -1;
  internals(c).state.doc.descendants((node, p) => {
    if (pos < 0 && node.type.name === 'form_field' && node.attrs['assignee'] === assignee) pos = p;
    return pos < 0;
  });
  return pos;
}

/** The position just inside the body paragraph `SPIKE_IDS.after`. */
function bodyPos(c: DocumentCore): number {
  let pos = -1;
  internals(c).state.doc.descendants((node, p) => {
    if (pos < 0 && node.attrs['id'] === SPIKE_IDS.after) pos = p + 1;
    return pos < 0;
  });
  return pos;
}

/**
 * Builds the change `make` describes on the document of `c` and runs the guard on it, as the
 * core's filter does. Returns the refusal, or null.
 */
function guardOf(c: DocumentCore, access: Access, make: (tr: Transaction) => void) {
  const before = internals(c).state.doc;
  const tr = internals(c).state.tr;
  make(tr);
  return checkChange(before, tr.doc, tr.steps, tr.docs, access, false);
}

describe('a participant who may only fill (FRW-076 criterion 1)', () => {
  it('the body is read-only: typing in the body is refused for a fill-only participant', () => {
    const c = core();
    insertFields(c);
    const pos = bodyPos(c);
    const refusal = guardOf(c, participantAccess(['tenant']), (tr) => {
      tr.insertText('x', pos);
    });
    expect(refusal?.reason).toBe('scope');
  });

  it('a field assigned to one of my roles takes a value', () => {
    const c = core();
    insertFields(c);
    const pos = fieldPos(c, 'tenant');
    expect(pos).toBeGreaterThanOrEqual(0);
    const refusal = guardOf(c, participantAccess(['tenant']), (tr) => {
      tr.setNodeAttribute(pos, 'value', 'Ada');
    });
    expect(refusal).toBeNull();
  });

  it('a field assigned to a role I do not hold refuses a value change', () => {
    const c = core();
    insertFields(c);
    const pos = fieldPos(c, 'landlord');
    expect(pos).toBeGreaterThanOrEqual(0);
    const refusal = guardOf(c, participantAccess(['tenant']), (tr) => {
      tr.setNodeAttribute(pos, 'value', 'Grace');
    });
    expect(refusal?.reason).toBe('scope');
  });

  it('an inactive participant changes no field value, even of their own role', () => {
    const c = core();
    insertFields(c);
    const pos = fieldPos(c, 'tenant');
    const refusal = guardOf(c, participantAccess(['tenant'], false), (tr) => {
      tr.setNodeAttribute(pos, 'value', 'Ada');
    });
    expect(refusal?.reason).toBe('scope');
  });
});
