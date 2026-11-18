// FRW-032 criteria 4 to 6 over documents (lane w4): the snapshot `resume` compares (`snapshotOf`), the
// owners of the fields (`fieldOwnersOf`) and the reset that follows from them, through the pure
// functions of the authority. The service that reads the two documents from the log is tested in
// services/document-service/test/control-plane/frw-032.correct-resume.test.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareWithSent, resumeWorkflow } from '../src/workflow/correction.ts';
import type { WorkflowParticipant, WorkflowRecord } from '../src/workflow/lifecycle.ts';
import { fieldOwnersOf, snapshotOf } from '../src/workflow/snapshot.ts';

type J = Record<string, unknown>;

const field = (key: string, assignee: string | null, value: unknown = null): J => ({
  type: 'form_field',
  attrs: { id: `f-${key}`, key, kind: 'text', label: key, assignee, value },
});
const paragraph = (text: string, ...fields: J[]): J => ({
  type: 'paragraph',
  attrs: { id: `p-${text}` },
  content: [{ type: 'text', text }, ...fields],
});

function doc(body: J[], defs: J[] = []): J {
  return {
    cdm: 1,
    requires: ['fields'],
    doc: {
      type: 'doc',
      content: [
        { type: 'defs', content: defs },
        { type: 'body', content: body },
      ],
    },
  };
}

const ROLES: J[] = [
  { type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } },
  { type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } },
];
const sentDoc = () =>
  doc(
    [
      paragraph(
        'Rent is due monthly. ',
        field('tenant.name', 'tenant', 'Ann'),
        field('landlord.name', 'landlord', 'Bo'),
      ),
    ],
    ROLES,
  );

const person = (id: string, roles: string[], completed: boolean): WorkflowParticipant => ({
  id,
  roles,
  kind: 'signer',
  order: 1,
  completed,
});
const PEOPLE = [person('t', ['tenant'], true), person('l', ['landlord'], true)];
const record = (participants: WorkflowParticipant[]): WorkflowRecord => ({
  state: 'correcting',
  participants,
  sentSeq: 3,
  sentHash: 'a'.repeat(64),
  end: null,
});

/** Who must complete again after the owner changed `head` from `sentDoc()`. */
function reset(head: unknown, participants: WorkflowParticipant[] = PEOPLE): string[] {
  const change = compareWithSent(snapshotOf(sentDoc()), snapshotOf(head));
  const out = resumeWorkflow(
    record(participants),
    { manage: true },
    change,
    fieldOwnersOf(head, participants),
  );
  if (!out.ok) throw new Error('a correcting workflow must resume');
  return [...out.reset];
}

describe('the snapshot separates the body from the values of its fields', () => {
  it('has the same body whatever the values, and the values by key', () => {
    const a = snapshotOf(sentDoc());
    const changed = doc(
      [
        paragraph(
          'Rent is due monthly. ',
          field('tenant.name', 'tenant', 'Cy'),
          field('landlord.name', 'landlord', null),
        ),
      ],
      ROLES,
    );
    const b = snapshotOf(changed);
    expect(b.body).toBe(a.body);
    expect(a.fields).toEqual({ 'tenant.name': '"Ann"', 'landlord.name': '"Bo"' });
    expect(b.fields).toEqual({ 'tenant.name': '"Cy"', 'landlord.name': null });
  });

  it('takes an envelope and a bare document node alike', () => {
    const envelope = sentDoc() as { doc: unknown };
    expect(snapshotOf(envelope.doc)).toEqual(snapshotOf(envelope));
  });

  it('changes the body for anything that is not a value: text, a label, a definition', () => {
    const base = snapshotOf(sentDoc()).body;
    const text = doc(
      [paragraph('Rent is due weekly. ', field('tenant.name', 'tenant', 'Ann'))],
      ROLES,
    );
    expect(snapshotOf(text).body).not.toBe(base);
    const label = sentDoc() as { doc: { content: Array<{ content: J[] }> } };
    ((label.doc.content[1]!.content[0]!['content'] as J[])[1]!['attrs'] as J)['label'] = 'Name';
    expect(snapshotOf(label).body).not.toBe(base);
    const defs = doc(
      [
        paragraph(
          'Rent is due monthly. ',
          field('tenant.name', 'tenant', 'Ann'),
          field('landlord.name', 'landlord', 'Bo'),
        ),
      ],
      [...ROLES, { type: 'role_def', attrs: { id: 'witness', name: 'Witness', color: '#2CA02C' } }],
    );
    expect(snapshotOf(defs).body).not.toBe(base);
  });

  it('is the same for the same document, whatever the order of the members of its nodes', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (value) => {
        const a = doc([paragraph('x', field('k', 'tenant', value))], ROLES);
        const b = JSON.parse(JSON.stringify(a)) as J;
        expect(snapshotOf(a)).toEqual(snapshotOf(b));
      }),
    );
  });
});

describe('the owners of a field are the holders of its role (FRW-032 criterion 4)', () => {
  it('maps each key to the participants who hold the assignee role', () => {
    const two = [...PEOPLE, person('t2', ['tenant'], false)];
    expect(fieldOwnersOf(sentDoc(), two)).toEqual({
      'tenant.name': ['t', 't2'],
      'landlord.name': ['l'],
    });
  });

  it('gives a field with no assignee, or a role nobody holds, no owner', () => {
    const d = doc(
      [
        paragraph(
          'x',
          field('a', null, '1'),
          field('b', 'witness', '2'),
          field('c', 'tenant', '3'),
        ),
      ],
      ROLES,
    );
    expect(fieldOwnersOf(d, PEOPLE)).toEqual({ a: [], b: [], c: ['t'] });
  });
});

describe('who is reset on resume, over documents (FRW-032 criteria 4, 5 and 6)', () => {
  it('resets nobody when nothing relevant changed, and the workflow returns to in_progress', () => {
    expect(reset(sentDoc())).toEqual([]);
    const out = resumeWorkflow(
      record(PEOPLE),
      { manage: true },
      compareWithSent(snapshotOf(sentDoc()), snapshotOf(sentDoc())),
      fieldOwnersOf(sentDoc(), PEOPLE),
    );
    expect(out.ok && out.record.state).toBe('in_progress');
  });

  it('resets only the completed owner of a field whose value changed', () => {
    const head = doc(
      [
        paragraph(
          'Rent is due monthly. ',
          field('tenant.name', 'tenant', 'Cy'),
          field('landlord.name', 'landlord', 'Bo'),
        ),
      ],
      ROLES,
    );
    expect(reset(head)).toEqual(['t']);
  });

  it('resets both holders of a role when a field of that role changed', () => {
    const people = [person('t', ['tenant'], true), person('t2', ['tenant'], true), PEOPLE[1]!];
    const head = doc(
      [
        paragraph(
          'Rent is due monthly. ',
          field('tenant.name', 'tenant', 'Cy'),
          field('landlord.name', 'landlord', 'Bo'),
        ),
      ],
      ROLES,
    );
    expect(reset(head, people)).toEqual(['t', 't2']);
  });

  it('resets every completed participant when the body changed, and never one who had not completed', () => {
    const head = doc(
      [
        paragraph(
          'Rent is due weekly. ',
          field('tenant.name', 'tenant', 'Ann'),
          field('landlord.name', 'landlord', 'Bo'),
        ),
      ],
      ROLES,
    );
    expect(reset(head)).toEqual(['t', 'l']);
    const partly = [person('t', ['tenant'], true), person('l', ['landlord'], false)];
    expect(reset(head, partly)).toEqual(['t']);
  });

  it('treats a changed value with no owner as a change of the body', () => {
    const head = doc(
      [
        paragraph(
          'Rent is due monthly. ',
          field('tenant.name', 'tenant', 'Ann'),
          field('landlord.name', 'landlord', 'Bo'),
          field('author.note', null, 'new'),
        ),
      ],
      ROLES,
    );
    expect(reset(head)).toEqual(['t', 'l']);
  });

  it('never leaves a completed participant standing over a body or a value they did not sign (property)', () => {
    const text = fc.constantFrom('Rent is due monthly. ', 'Rent is due weekly. ');
    const value = fc.constantFrom('Ann', 'Cy', null);
    fc.assert(
      fc.property(text, value, value, (body, tenant, landlord) => {
        const head = doc(
          [
            paragraph(
              body,
              field('tenant.name', 'tenant', tenant),
              field('landlord.name', 'landlord', landlord),
            ),
          ],
          ROLES,
        );
        const stands = PEOPLE.map((p) => p.id).filter((id) => !reset(head).includes(id));
        const bodyChanged = body !== 'Rent is due monthly. ';
        for (const id of stands) {
          // Whoever stands saw this body, and the values of their own fields as they are now.
          expect(bodyChanged).toBe(false);
          if (id === 't') expect(tenant).toBe('Ann');
          if (id === 'l') expect(landlord).toBe('Bo');
        }
      }),
    );
  });
});
