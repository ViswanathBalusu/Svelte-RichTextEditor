// A field value is part of the document's history like any attribute (12 §3.3; FRW-003 criterion 5):
// content read at a sequence number holds the value that was current there, and the commit that
// changed the value later is stamped with the field's scope, as any attribute change is. The
// restore criterion (6) is not tested here: it needs the restore path of the room.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { contentAt, type ContentSource, defaultReplayers } from '../src/room/content.ts';
import { ENGINE, type StoredCommit } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { posInside, posOf } from './fixtures.ts';
import { FIELDS, fieldsDoc, schema } from './permission-fixtures.ts';

const FIELD_SCOPE = `field:${FIELDS.number}`;

/**
 * Seq 10 sets the value to "12.50"; seq 20 changes it to "13.00"; every other commit types in the
 * introduction paragraph. Returns the source that `contentAt` reads from.
 */
function fieldLog(head: number): { source: ContentSource; commits: StoredCommit[]; base: Node } {
  const base = fieldsDoc();
  const commits: StoredCommit[] = [];
  let doc = base;
  for (let seq = 1; seq <= head; seq++) {
    const isValue = seq === 10 || seq === 20;
    const value = seq === 10 ? '12.50' : '13.00';
    const step: Step = isValue
      ? new AttrStep(posOf(doc, FIELDS.number), 'value', value)
      : (() => {
          const at = posInside(doc, 'pIntro0000000001');
          return new ReplaceStep(at, at, new Slice(Fragment.from(schema.text(`${seq}`)), 0, 0));
        })();
    doc = step.apply(doc).doc!;
    commits.push({
      seq,
      id: `0192f0c4-7b1e-7000-8000-${seq.toString(16).padStart(12, '0')}`,
      user: isValue ? 'erin' : 'alice',
      session: isValue ? 's-erin' : 's-alice',
      time: 1_000 + seq,
      scopes: isValue ? [FIELD_SCOPE] : ['body'],
      revision: 1,
      cdm: 1,
      engine: ENGINE,
      retired: [],
      claimed: [],
      kind: 'steps',
      steps: stepsToJson([step]),
      origin: isValue ? 'fill' : 'input',
    } as StoredCommit);
  }
  const source: ContentSource = {
    incarnation: 'inc-1',
    head,
    checkpoints: [{ seq: 0, doc: base }],
    commits: (after, to) => commits.filter((c) => c.seq > after && c.seq <= to),
    resolve: () => {
      throw new Error('no snapshot in this log');
    },
    replayers: defaultReplayers(schema),
  };
  return { source, commits, base };
}

const valueAt = (doc: Node): unknown => doc.nodeAt(posOf(doc, FIELDS.number))!.attrs['value'];

describe('FRW-003 a field value is read at the sequence number it was current (criterion 5)', () => {
  it('holds the value set at seq 10 when content is read at seq 15', () => {
    const { source } = fieldLog(25);
    const at15 = contentAt(15, source);
    expect(at15.ok).toBe(true);
    if (at15.ok) expect(valueAt(at15.doc)).toBe('12.50');
  });

  it('holds the later value from seq 20 and the earlier one before seq 10', () => {
    const { source } = fieldLog(25);
    const at9 = contentAt(9, source);
    const at20 = contentAt(20, source);
    expect(at9.ok && valueAt(at9.doc)).toBe(null);
    expect(at20.ok && valueAt(at20.doc)).toBe('13.00');
  });

  it('stamps the change at seq 20 with the field scope alone, as any attribute change is stamped', () => {
    const { commits } = fieldLog(25);
    const change = commits.find((c) => c.seq === 20)!;
    expect(change.scopes).toEqual([FIELD_SCOPE]);
    expect(commits.find((c) => c.seq === 15)!.scopes).toEqual(['body']);
  });
});
