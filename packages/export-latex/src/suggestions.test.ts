/**
 * Suggestions in output, the `accept` and `reject` modes and the converter's half of the refusal
 * of unresolved suggestions (Node.js only): EXP-081 (partly) and EXP-082 (converter side). The
 * documents come from `test/docs.ts` and the helpers from `test/suggestions.ts`. Nothing here
 * compiles, so the PDF's text is not checked: the text is read from main.tex. Not covered here,
 * and so not ticked: the `fmt` revert of EXP-081 criterion 2, the block permission rule of
 * criterion 3, the unverifiable mark of criterion 4, the editor's text of criterion 6, the
 * service's refusal and its problem details (EXP-082 criteria 1, 2 and 4), and the commit of
 * EXP-081 criterion 5.
 */
import { describe, expect, it } from 'vitest';
import { codes, doc, para, run, type J } from '../test/docs.ts';
import { delMark, insMark, markedPara, printed, tableOf, text } from '../test/suggestions.ts';

/** A document with a marked run, a marked paragraph, a marked row and a marked table. */
function marked(): J[] {
  return [
    para('', {}, [
      text('Keep '),
      text('gone', [delMark(1)]),
      text('new ', [insMark(2)]),
      text('end.'),
    ]),
    markedPara('Struck paragraph.', [delMark(6)]),
    markedPara('Added paragraph.', [insMark(7)]),
    tableOf([{ cells: ['row one'] }, { cells: ['row two'], marks: [delMark(3)] }]),
    tableOf([{ cells: ['table gone'] }], [delMark(4)]),
    tableOf([{ cells: ['table added'] }], [insMark(5)]),
  ];
}

/** The same document with every suggestion accepted, written by hand (the expected output). */
function acceptedByHand(): J[] {
  return [
    para('', {}, [text('Keep '), text('new '), text('end.')]),
    para('Added paragraph.'),
    tableOf([{ cells: ['row one'] }]),
    tableOf([{ cells: ['table added'] }]),
  ];
}

describe('EXP-081 accept and reject of suggestions (converter side)', () => {
  it('accept keeps inserted text and drops deleted text; reject does the reverse', async () => {
    const body = [
      para('', {}, [
        text('Keep '),
        text('gone', [delMark(1)]),
        text('new ', [insMark(2)]),
        text('end.'),
      ]),
    ];
    const accepted = await run(doc(structuredClone(body)), { suggestions: 'accept' });
    const rejected = await run(doc(structuredClone(body)), { suggestions: 'reject' });
    expect(printed(accepted)).toBe('Keep new end.');
    expect(printed(rejected)).toBe('Keep goneend.');
  });

  it('drops a deleted paragraph under accept and keeps it under reject; an inserted one does the reverse', async () => {
    const body = [
      para('Plain.'),
      markedPara('Struck paragraph.', [delMark(6)]),
      markedPara('Added paragraph.', [insMark(7)]),
    ];
    const accepted = await run(doc(structuredClone(body)), { suggestions: 'accept' });
    const rejected = await run(doc(structuredClone(body)), { suggestions: 'reject' });
    expect(printed(accepted)).toContain('Added paragraph.');
    expect(printed(accepted)).not.toContain('Struck paragraph.');
    expect(printed(rejected)).toContain('Struck paragraph.');
    expect(printed(rejected)).not.toContain('Added paragraph.');
  });

  it('applies the same rule to whole table rows and whole tables (block suggestions)', async () => {
    const accepted = await run(doc(structuredClone(marked())), { suggestions: 'accept' });
    const rejected = await run(doc(structuredClone(marked())), { suggestions: 'reject' });
    expect(printed(accepted)).not.toContain('row two');
    expect(printed(accepted)).not.toContain('table gone');
    expect(printed(accepted)).toContain('table added');
    expect(printed(rejected)).toContain('row two');
    expect(printed(rejected)).toContain('table gone');
    expect(printed(rejected)).not.toContain('table added');
  });

  it('prints under accept the same text as the document with its suggestions accepted by hand', async () => {
    const accepted = await run(doc(structuredClone(marked())), { suggestions: 'accept' });
    const expected = await run(doc(acceptedByHand()));
    expect(printed(accepted)).toBe(printed(expected));
  });

  it('does not change the document it reads, and gives the same bundle on every run', async () => {
    const env = doc(structuredClone(marked()));
    const before = JSON.stringify(env);
    const a = await run(env, { suggestions: 'accept' });
    const b = await run(env, { suggestions: 'accept' });
    expect(JSON.stringify(env)).toBe(before);
    expect(b.files).toEqual(a.files);
    expect(b.manifest.bundleHash).toBe(a.manifest.bundleHash);
  });
});

describe('EXP-082 unresolved suggestions (converter side)', () => {
  it('reports pending_suggestions as an error when the option is missing, and prints the text as rejected', async () => {
    const body = [
      para('', {}, [
        text('Keep '),
        text('gone', [delMark(1)]),
        text('new ', [insMark(2)]),
        text('end.'),
      ]),
    ];
    const bundle = await run(doc(body));
    expect(bundle.ok).toBe(false);
    const d = bundle.diagnostics.find((x) => x.code === 'pending_suggestions');
    expect(d?.severity).toBe('error');
    expect(printed(bundle)).toBe('Keep goneend.');
  });

  it('accepts the options accept, reject and markup without the pending_suggestions error', async () => {
    const body = [para('', {}, [text('A '), text('b', [insMark(1)])])];
    for (const suggestions of ['accept', 'reject', 'markup'] as const) {
      const bundle = await run(doc(structuredClone(body)), { suggestions });
      expect(codes(bundle)).not.toContain('pending_suggestions');
    }
  });

  it('gives no pending_suggestions error for a document without suggestions and with no option', async () => {
    const bundle = await run(doc([para('No suggestions here.')]));
    expect(codes(bundle)).not.toContain('pending_suggestions');
    expect(bundle.ok).toBe(true);
  });
});
