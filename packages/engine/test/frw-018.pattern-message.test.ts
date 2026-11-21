/**
 * FRW-018 criterion 4 in the editing core, in Node.js: an entry that does not match the
 * `validation.pattern` of its field is reported invalid with the message the author gave
 * (`validation.message`; owner decision 187 of 2026-11-15).
 *
 * - The core reports it through every reading the editor has: the result of the entry, the state of
 *   the field, the check made while typing, `validateFields()` of the embedding API and the list of
 *   fields of the fill mode.
 * - The author gives the message with `editField`, the commit the properties panel makes. It goes
 *   through backend-mock's real room, which validates the attribute, and a participant on the same
 *   document is then told the author's words.
 *
 * The control's `aria-invalid` and its message are tested in the browser
 * (src/view/frw-018-pattern-message.universal.test.ts); the completion check is tested with the
 * authority and the document service.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { CODE, MESSAGE, PATTERN, PLAIN, patternDocument } from './frw-018-fixture.ts';
import { participantAccess } from './frw-fields-fixture.ts';
import { join, microtask, newService, traffic, until } from './support.ts';
import { loadParts } from '../src/parts.ts';

// The rules language and the authoring checks load on first use (FND-008; engine parts.ts).
beforeAll(() => loadParts(['authoring', 'rules']));

const authored = [{ code: 'pattern', message: MESSAGE, authored: true }];

describe('an entry that does not match its pattern (FRW-018 criterion 4, the core)', () => {
  const core = (validation?: Record<string, unknown>) =>
    new DocumentCore({ doc: patternDocument(validation), schedule: microtask });

  it('is reported invalid with the message the author gave, through every reading', () => {
    const c = core();
    // While typing, before anything is submitted.
    expect(c.checkFieldEntry(CODE, 'ab12')).toEqual(authored);
    expect(c.fieldEntry(CODE)?.problems).toEqual([]);

    expect(c.enterFieldValue(CODE, 'ab12')).toEqual({ ok: true, problems: authored });
    expect(c.fieldEntry(CODE)).toMatchObject({ value: 'ab12', problems: authored });
    expect(c.validateFields().find((r) => r.key === 'tenant.code')).toEqual({
      key: 'tenant.code',
      id: CODE,
      problems: authored,
    });
    // The fill mode lists the field as invalid by its form; the list carries no text.
    expect(c.fillFields().find((f) => f.id === CODE)).toMatchObject({
      filled: true,
      invalid: 'format',
    });
    c.destroy();
  });

  it('is valid again once the entry matches, and an empty entry has nothing to match', () => {
    const c = core();
    c.enterFieldValue(CODE, 'ab12');
    expect(c.enterFieldValue(CODE, 'AB1234')).toEqual({ ok: true, problems: [] });
    expect(c.fieldEntry(CODE)).toMatchObject({ value: 'AB1234', stored: 'AB1234', problems: [] });
    expect(c.validateFields().map((r) => r.key)).not.toContain('tenant.code');
    expect(c.fillFields().find((f) => f.id === CODE)).toMatchObject({ invalid: null });
    expect(c.enterFieldValue(CODE, '')).toEqual({ ok: true, problems: [] });
    c.destroy();
  });

  it('has the wording of the package when the author gave no message', () => {
    const c = core({ pattern: PATTERN });
    expect(c.enterFieldValue(CODE, 'ab12')).toEqual({
      ok: true,
      problems: [{ code: 'pattern', message: PLAIN }],
    });
    c.destroy();
  });

  it('takes the message the author sets with editField, and one undo takes it back', () => {
    const c = core({ pattern: PATTERN });
    c.enterFieldValue(CODE, 'ab12');
    expect(c.fieldEntry(CODE)?.problems.map((p) => p.message)).toEqual([PLAIN]);

    expect(c.editField(CODE, { validation: { pattern: PATTERN, message: MESSAGE } })).toEqual({
      ok: true,
    });
    expect(c.fieldProperties(CODE)?.validation).toEqual({ pattern: PATTERN, message: MESSAGE });
    expect(c.fieldEntry(CODE)?.problems).toEqual(authored);

    // A message the grammar of the document refuses is not taken, and nothing changes.
    for (const bad of ['', 'x'.repeat(256), 'bell\u0007']) {
      const outcome = c.editField(CODE, { validation: { pattern: PATTERN, message: bad } });
      expect(outcome).toMatchObject({ ok: false, reason: 'invalid' });
      expect(c.fieldEntry(CODE)?.problems).toEqual(authored);
    }

    expect(c.run('undo')).toBe(true);
    expect(c.fieldProperties(CODE)?.validation).toEqual({ pattern: PATTERN });
    expect(c.fieldEntry(CODE)?.problems.map((p) => p.message)).toEqual([PLAIN]);
    c.destroy();
  });
});

describe('the message from the author to the participant, through the real room (FRW-018 criterion 4)', () => {
  it('is stored by the authority and governs the entry of a participant who joins', async () => {
    traffic.clear();
    const service = newService();
    const docId = service.createDocument(patternDocument({ pattern: PATTERN }));
    const author = await join(service, docId, 'ann', 'owner');
    try {
      // The author gives the message: one commit, which the room's validation accepts.
      expect(
        author.core.editField(CODE, { validation: { pattern: PATTERN, message: MESSAGE } }),
      ).toEqual({ ok: true });
      await until(() => traffic.acks === 1, 'the definition is acknowledged');
      expect([...traffic.rejects.keys()]).toEqual([]);

      // A participant opens the stored document and fills the field.
      const backend = service.backend(
        { sub: 'tessa', fill: { roles: ['role_tenant'] } },
        { [docId]: 'filler' },
      );
      await backend.connect();
      const content = await backend.sync.loadContent(docId);
      const participant = new DocumentCore({
        doc: content,
        mode: 'fill',
        access: participantAccess(['role_tenant']),
        schedule: microtask,
      });
      expect(participant.fieldFillable(CODE)).toBe(true);
      expect(participant.enterFieldValue(CODE, 'ab12')).toEqual({ ok: true, problems: authored });
      expect(participant.validateFields().find((r) => r.key === 'tenant.code')?.problems).toEqual(
        authored,
      );
      expect(participant.enterFieldValue(CODE, 'AB1234')).toEqual({ ok: true, problems: [] });
      participant.destroy();
    } finally {
      author.detach();
    }
  });
});
