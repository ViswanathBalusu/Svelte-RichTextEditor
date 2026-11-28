/**
 * EXP-025 criterion 3: the comparison of the text of a multi-page PDF with the input
 * (`test/paged-text.ts`) reports lost text and accepts what a page break does to a run. No
 * compile: the PDF text is written here, as `pdftotext -raw` returns it.
 */
import { describe, expect, it } from 'vitest';
import { comparePaged, type PagedRuns } from '../test/paged-text.ts';

const runs = (body: string[], more: Partial<PagedRuns> = {}): PagedRuns => ({
  body,
  notes: [],
  furniture: [],
  headings: [],
  ...more,
});

const PAGE_BREAK = [
  '',
  '3Footnote text of page one.',
  'Page 1 of 2',
  '\f',
  'Running head',
  '',
].join('\n');

describe('EXP-025 criterion 3: comparing the text of a multi-page PDF with its input', () => {
  it('accepts a run that a page break cuts in two, with a footnote, a footer and a header between', () => {
    const run = 'The quick brown fox jumps over the lazy dog while the page ends here and goes on.';
    const pdf = [
      'The quick brown fox jumps over the lazy dog while the page',
      PAGE_BREAK,
      'ends here and goes on.',
    ].join('\n');
    const r = comparePaged(
      pdf,
      runs([run], {
        notes: ['Footnote text of page one.'],
        furniture: ['Page', 'of'],
        headings: ['Running head'],
      }),
    );
    expect(r.missing).toEqual([]);
    expect(r.letters).toEqual([]);
  });

  it('reports a line that is not in the PDF text, as a line pushed past the margin is not', () => {
    const run =
      'First line of the paragraph and the second line of the paragraph and a third line.';
    const pdf = ['First line of the paragraph and the second', 'line of the paragraph'].join('\n');
    const r = comparePaged(pdf, runs([run]));
    expect(r.missing).toEqual(['anda' + 'thirdline.']);
  });

  it('reports text of the PDF that no run accounts for', () => {
    const r = comparePaged('Alpha beta gamma added words', runs(['Alpha beta gamma']));
    expect(r.missing).toEqual([]);
    expect(r.letters.join('')).toBe('addedwords');
  });

  it('does not count a hyphen or a space the typesetter added or dropped', () => {
    const r = comparePaged(
      'exten-\nsion of the text',
      runs(['extension of the', ' text'], { furniture: [] }),
    );
    expect(r.missing).toEqual([]);
    expect(r.letters).toEqual([]);
  });

  it('puts a float above the paragraph that precedes it in the input', () => {
    const para =
      'The paragraph runs on until the page ends and then it carries on to the next page.';
    const caption = 'Figure one: a caption set at the top of the next page';
    const pdf = [
      'The paragraph runs on until the page ends',
      '\f',
      caption,
      'and then it carries on to the next page.',
    ].join('\n');
    const r = comparePaged(pdf, runs([para, caption], { floatAt: new Set([1]) }));
    expect(r.missing).toEqual([]);
    expect(r.unordered).toEqual([caption.replace(/\s/gu, '')]);
  });

  it('takes the lines of the contents list out and checks that they repeat the headings', () => {
    const pdf = [
      'Contents',
      '1 Introduction . . . . . . . . . . . . . . . 1',
      'Introduction',
      'Body text of the section.',
    ].join('\n');
    const ok = comparePaged(
      pdf,
      runs(['Contents', 'Introduction', 'Body text of the section.'], {
        headings: ['Introduction'],
      }),
    );
    expect(ok.contentsMissing).toEqual([]);
    const bad = comparePaged(
      pdf,
      runs(['Contents', 'Body text of the section.'], { headings: ['Missing'] }),
    );
    expect(bad.contentsMissing).toEqual(['Missing']);
  });
});
