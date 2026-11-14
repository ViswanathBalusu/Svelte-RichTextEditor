/**
 * Footnote marks come from the shared numbering algorithm (FE-084 criterion 4): the format of
 * `settings.footnoteFormat` and the restart of `settings.footnoteRestart` (`perPageSection` restarts
 * at every section break). The cases are the footnote fixture of `packages/model`, the same ones
 * its own label tests check, assembled into a CDM envelope the way that fixture's format says.
 */
import footnotes from '@docedit/model/fixtures/semantics/numbering-footnotes.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';

type J = Record<string, unknown>;

interface FootnoteCase {
  id: string;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  stories?: J[];
  body?: J[];
  expected: { footnotes?: { id: string; text: string }[] };
}

const file = footnotes as unknown as {
  settings?: J;
  styles?: J[];
  numberings?: J[];
  cases: FootnoteCase[];
};

/** A case's own entries replace the file's with the same identifier, as in the model's test. */
function mergeById(base: readonly J[], extra: readonly J[]): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

/** The CDM envelope of a case: its defs (settings, styles, numberings, page setup `ps1`), stories, body. */
function envelopeOf(c: FootnoteCase): CdmEnvelopeLike {
  const defs = {
    type: 'defs',
    content: [
      { type: 'settings', attrs: { ...file.settings, ...c.settings } },
      ...mergeById(file.styles ?? [], c.styles ?? []),
      ...mergeById(file.numberings ?? [], c.numberings ?? []),
      { type: 'page_setup', attrs: { id: 'ps1' } },
    ],
  };
  const doc = {
    type: 'doc',
    content: [
      defs,
      ...(c.stories ?? []),
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: c.body ?? [] },
    ],
  };
  return { doc: doc as unknown as CdmNode };
}

const caseOf = (id: string): FootnoteCase => {
  const c = file.cases.find((x) => x.id === id);
  if (!c) throw new Error(`no footnote case ${id}`);
  return c;
};

describe('footnote marks from the shared numbering algorithm (FE-084 criterion 4)', () => {
  it('restarts the marks at every section break under perPageSection', () => {
    const c = caseOf('restart-per-page-section');
    const flow = toFlow(envelopeOf(c));
    expect(c.settings).toEqual({ footnoteRestart: 'perPageSection' });
    expect(
      [
        'fn01xxxxxxxxxxxx',
        'fn02xxxxxxxxxxxx',
        'fn03xxxxxxxxxxxx',
        'fn04xxxxxxxxxxxx',
        'fn05xxxxxxxxxxxx',
      ].map((id) => flow.notes.get(id)?.label),
    ).toEqual(['1', '2', '1', '2', '1']);
  });

  it('keeps counting through section breaks under continuous', () => {
    const c = caseOf('continuous-across-section-breaks');
    const flow = toFlow(envelopeOf(c));
    expect(
      ['fn01xxxxxxxxxxxx', 'fn02xxxxxxxxxxxx', 'fn03xxxxxxxxxxxx'].map(
        (id) => flow.notes.get(id)?.label,
      ),
    ).toEqual(['1', '2', '3']);
  });

  it.each(
    file.cases
      .filter((c) => c.expected.footnotes && c.expected.footnotes.length > 0)
      .map((c) => [c.id, c] as const),
  )('gives every body footnote of %s the mark the shared algorithm gives it', (_id, c) => {
    const flow = toFlow(envelopeOf(c));
    for (const { id, text } of c.expected.footnotes ?? []) {
      expect(flow.notes.get(id)?.label, `footnote ${id}`).toBe(text);
    }
  });

  it('numbers the same footnotes as the shared algorithm when its format is symbols', () => {
    const c = caseOf('symbols');
    const flow = toFlow(envelopeOf(c));
    expect(flow.notes.get('fn05xxxxxxxxxxxx')?.label).toBe('**');
    expect(flow.notes.get('fn09xxxxxxxxxxxx')?.label).toBe('***');
  });
});
