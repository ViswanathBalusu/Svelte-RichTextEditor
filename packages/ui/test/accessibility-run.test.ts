/**
 * The accessibility checker over the document the core holds (UX-066 criteria 1, 4 and 6; UX-067
 * criterion 3). A core (the test stand-in, `FakeCore`) gives a CDM document through `getContent`,
 * its DEP access through `permissions` and its region list through `regions`, as the engine does;
 * `runAccessibilityCheck` builds the checker's view from them and lists each issue with whether
 * this user may fix it.
 */
import { describe, expect, it } from 'vitest';
import type { AccessObject, RegionSummary } from '../src/core-api.ts';
import { sourceTranslator } from '../src/i18n/strings.ts';
import { checkViewOfContent, HIGHLIGHT_RGB } from '../src/shell/accessibility-content.ts';
import { runAccessibilityCheck } from '../src/shell/accessibility-run.ts';
import { FakeCore } from './support/fake-core.ts';

const tr = sourceTranslator();
const NAMES: Record<string, string> = { 'user:u1': 'Ada', 'user:u2': 'Grace' };
const nameOf = (principal: string): string => NAMES[principal] ?? principal;

type J = Record<string, unknown>;
const text = (t: string, ...marks: J[]): J =>
  marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const mark = (type: string, attrs: J): J => ({ type, attrs });
const para = (id: string, style: string | null, content: J[], extra: J = {}): J => ({
  type: 'paragraph',
  attrs: { id, style, ...extra },
  content,
});
const style = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, builtIn: false, ...attrs },
});
const cell = (id: string, content: J[], shading: J | null = null): J => ({
  type: 'table_cell',
  attrs: { id, colspan: 1, rowspan: 1, shading },
  content,
});
const table = (id: string, headerRows: number, cells: J[]): J => ({
  type: 'table',
  attrs: { id, style: null, grid: cells.map(() => 2000), headerRows },
  content: [{ type: 'table_row', attrs: { id: `${id}-row` }, content: cells }],
});

/** A CDM envelope in the shape of 03 section 12, with one occurrence of each kind of issue. */
function documentWithIssues(): J {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
            style('Normal', { builtIn: true }),
            style('Heading1', { builtIn: true, basedOn: 'Normal', outlineLevel: 1 }),
            style('Heading2', { builtIn: true, basedOn: 'Normal', outlineLevel: 2 }),
            style('Heading3', { builtIn: true, basedOn: 'Normal', outlineLevel: 3 }),
            // Inherits outline level 2 from Heading2 through `basedOn`.
            style('Appendix', { basedOn: 'Heading2' }),
            style('Caption', { builtIn: true, basedOn: 'Normal' }),
            // White text on dark shading: passes although the page is white.
            style('Banner', { basedOn: 'Normal', color: '#FFFFFF', shading: { fill: '#1F1F1F' } }),
            {
              type: 'style_def',
              attrs: { id: 'Faint', kind: 'character', name: 'Faint', color: '#AAAAAA' },
            },
            { type: 'page_setup', attrs: { id: 'ps1', width: 11906, height: 16838 } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            para('pScope', 'Heading1', [text('Scope')]),
            para('pAppendix', 'Appendix', [text('Terms')]),
            // Level 2 to level 3 is fine; level 1 to level 3 below skips level 2.
            para('pTerms', 'Heading3', [text('Detail')]),
            para('pSkip', 'Heading1', [text('Annex')]),
            para('pJump', 'Heading3', [text('Too deep')]),
            para('pLinks', null, [
              text('Read the report '),
              text('click ', mark('link', { href: 'https://example.com/r' })),
              text('here', mark('link', { href: 'https://example.com/r' })),
              text(' or the '),
              text('Annual report 2026', mark('link', { href: 'https://example.com/a' })),
              text('.'),
              { type: 'image', attrs: { asset: 'a1', width: 100, height: 100, alt: '' } },
              { type: 'image', attrs: { asset: 'a2', width: 100, height: 100, alt: 'A logo' } },
            ]),
            {
              type: 'figure',
              attrs: { id: 'fNoAlt', asset: 'a3', width: 4000, height: 3000, alt: null },
              content: [{ type: 'caption', content: [text('Figure 1')] }],
            },
            {
              type: 'figure',
              attrs: { id: 'fAlt', asset: 'a4', width: 4000, height: 3000, alt: 'A chart' },
            },
            table('tNoHeader', 0, [
              cell('c1', [para('pOnBlack', null, [text('Black on a black cell')])], {
                fill: '#000000',
              }),
            ]),
            table('tHeader', 1, [cell('c2', [para('pCell', null, [text('Fine')])])]),
            para('pBanner', 'Banner', [text('White on the banner shading')]),
            para('pNavy', null, [text('Black on navy', mark('highlight', { value: 'darkBlue' }))]),
            para('pYellow', null, [
              text('Black on yellow', mark('highlight', { value: 'yellow' })),
            ]),
            para('pWhite', null, [text('White on the page', mark('color', { value: '#FFFFFF' }))]),
            {
              type: 'region',
              attrs: { id: 'rLegal', title: 'Legal review', policy: 'restricted' },
              content: [
                {
                  type: 'figure',
                  attrs: { id: 'fLegal', asset: 'a5', width: 4000, height: 3000, alt: '  ' },
                },
              ],
            },
            {
              type: 'region',
              attrs: { id: 'rMine', title: 'My part', policy: 'inherit' },
              content: [
                para('pFaint', null, [text('Faint words', mark('charStyle', { style: 'Faint' }))]),
              ],
            },
            para('pEnd', null, []),
          ],
        },
      ],
    },
  };
}

const EDITOR: AccessObject = {
  rev: 3,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:rLegal': ['view', 'comment'],
    'region:rMine': ['view', 'comment', 'suggest', 'edit'],
  },
};

const VIEWER: AccessObject = {
  rev: 3,
  docRole: 'viewer',
  caps: ['view'],
  scopes: { body: ['view'], 'region:rLegal': ['view'], 'region:rMine': ['view'] },
};

const REGIONS: RegionSummary[] = [
  {
    id: 'rLegal',
    title: 'Legal review',
    policy: 'restricted',
    order: 0,
    state: 'draft',
    editors: { roles: ['owner'], principals: ['user:u1'] },
  },
  {
    id: 'rMine',
    title: 'My part',
    policy: 'inherit',
    order: 1,
    state: 'draft',
    editors: { roles: ['editor', 'owner'], principals: [] },
  },
];

function coreWith(content: unknown, permissions: AccessObject | null): FakeCore {
  const core = new FakeCore({ extended: true, permissions, regions: REGIONS });
  Object.assign(core, { getContent: () => content });
  return core;
}

function byKind(result: NonNullable<ReturnType<typeof runAccessibilityCheck>>) {
  return Object.fromEntries(
    result.report.groups.map((g) => [g.kind, g.issues.map((i) => i.blockId)]),
  );
}

describe('the checker runs over the document the core holds (UX-066, criterion 1)', () => {
  it('lists issues of the five kinds, each at the block it is in', () => {
    const result = runAccessibilityCheck(coreWith(documentWithIssues(), EDITOR), tr, nameOf)!;
    expect(byKind(result)).toEqual({
      'alt-text': ['pLinks', 'fNoAlt', 'fLegal'],
      'heading-order': ['pJump'],
      'table-header': ['tNoHeader'],
      'link-text': ['pLinks'],
      contrast: ['pOnBlack', 'pNavy', 'pWhite', 'pFaint'],
    });
    expect(result.report.count).toBe(10);
    // The generic link is the one flagged; the descriptive one is not.
    expect(result.report.groups.find((g) => g.kind === 'link-text')!.issues[0]!.detail).toEqual({
      reason: 'generic',
      index: 0,
    });
  });

  it('reads heading levels through the basedOn chain of the paragraph style', () => {
    const view = checkViewOfContent(documentWithIssues());
    const levels = view.blocks
      .filter((b) => b.kind === 'paragraph' && b.outlineLevel !== null)
      .map((b) => [b.id, b.kind === 'paragraph' ? b.outlineLevel : null]);
    expect(levels).toEqual([
      ['pScope', 1],
      ['pAppendix', 2],
      ['pTerms', 3],
      ['pSkip', 1],
      ['pJump', 3],
    ]);
  });

  it('a document without issues gives an empty report, and a core without getContent none', () => {
    const clean = documentWithIssues();
    const body = ((clean['doc'] as J)['content'] as J[])[1]!;
    body['content'] = [para('p1', 'Heading1', [text('Scope')]), para('p2', null, [text('Body.')])];
    expect(runAccessibilityCheck(coreWith(clean, EDITOR), tr, nameOf)!.report).toEqual({
      groups: [],
      count: 0,
    });
    const without = new FakeCore({ extended: true });
    expect(runAccessibilityCheck(without, tr, nameOf)).toBeNull();
  });
});

describe('contrast uses the document colours against the output page (UX-066, criterion 4)', () => {
  it('takes the text colour, the highlight and the shading from the document', () => {
    const view = checkViewOfContent(documentWithIssues());
    const runsOf = (id: string) => {
      const b = view.blocks.find((x) => x.id === id && x.kind === 'paragraph');
      return b && b.kind === 'paragraph' ? b : null;
    };
    // Text colour from a direct mark, and from a character style.
    expect(runsOf('pWhite')!.runs[0]!.color).toBe('#FFFFFF');
    expect(runsOf('pFaint')!.runs[0]!.color).toBe('#AAAAAA');
    // A Word highlight name becomes its colour.
    expect(runsOf('pNavy')!.runs[0]!.highlight).toBe(HIGHLIGHT_RGB['darkBlue']);
    // Shading from the paragraph style, and from the table cell.
    expect(runsOf('pBanner')!.shading).toBe('#1F1F1F');
    expect(runsOf('pBanner')!.runs[0]!.color).toBe('#FFFFFF');
    expect(runsOf('pOnBlack')!.shading).toBe('#000000');
    // The page is the output's white, whatever theme the editor shows.
    expect(view.options).toEqual({ pageBackground: '#ffffff', defaultTextColor: '#000000' });
  });

  it('passes white on dark shading and black on yellow, and fails the pairs below 4.5 to 1', () => {
    const result = runAccessibilityCheck(coreWith(documentWithIssues(), EDITOR), tr, nameOf)!;
    const contrast = result.report.groups.find((g) => g.kind === 'contrast')!.issues;
    const ids = contrast.map((i) => i.blockId);
    expect(ids).not.toContain('pBanner');
    expect(ids).not.toContain('pYellow');
    expect(ids).not.toContain('pCell');
    // Black on navy (#000080) and white on white are below the minimum; the ratios are reported.
    // Each also names the colour the fix of UX-067 offers: black on white, white on black.
    expect(contrast.find((i) => i.blockId === 'pWhite')!.detail).toEqual({
      ratio: 1,
      suggest: '#000000',
    });
    expect(contrast.find((i) => i.blockId === 'pOnBlack')!.detail).toEqual({
      ratio: 1,
      suggest: '#FFFFFF',
    });
    expect(Number(contrast.find((i) => i.blockId === 'pNavy')!.detail['ratio'])).toBeLessThan(4.5);
  });
});

describe('the checker does not change the document (UX-066, criterion 6)', () => {
  it('reads a frozen document, leaves it as it was, and asks the core for nothing else', () => {
    const doc = deepFreeze(documentWithIssues());
    const before = JSON.stringify(doc);
    const core = coreWith(doc, EDITOR);
    const revision = core.revision.get();
    const first = runAccessibilityCheck(core, tr, nameOf);
    const second = runAccessibilityCheck(core, tr, nameOf);
    expect(JSON.stringify(doc)).toBe(before);
    expect(second).toEqual(first);
    // No command, named command, selection or focus call reached the core.
    expect(core.calls).toEqual([]);
    expect(core.revision.get()).toBe(revision);
  });
});

describe('an issue in a scope the user cannot change says who can (UX-067, criterion 3)', () => {
  it('marks the issue in a region without edit as not fixable, with its editors', () => {
    const result = runAccessibilityCheck(coreWith(documentWithIssues(), EDITOR), tr, nameOf)!;
    const legal = result.issues.find((i) => i.issue.blockId === 'fLegal')!;
    expect(legal.scope).toBe('region:rLegal');
    expect(legal.fix).toEqual({
      fixable: false,
      fix: 'picture.altText',
      blockId: 'fLegal',
      who: 'It can be edited by Ada, and by document owners.',
    });
    // The body and the region the user may edit offer their fixes.
    const mine = result.issues.find((i) => i.issue.blockId === 'pFaint')!;
    expect(mine.scope).toBe('region:rMine');
    expect(mine.fix).toEqual({ fixable: true, fix: 'format.colour', blockId: 'pFaint' });
    const others = result.issues.filter((i) => i.issue.blockId !== 'fLegal');
    expect(others.every((i) => i.fix.fixable)).toBe(true);
  });

  it('for a viewer, marks every issue as not fixable and says who can edit each scope', () => {
    const result = runAccessibilityCheck(coreWith(documentWithIssues(), VIEWER), tr, nameOf)!;
    expect(result.issues).toHaveLength(10);
    expect(result.issues.every((i) => !i.fix.fixable)).toBe(true);
    const who = Object.fromEntries(
      result.issues.map((i) => [i.issue.blockId, i.fix.fixable ? null : i.fix.who]),
    );
    expect(who['pJump']).toBe('It can be edited by document editors and owners.');
    expect(who['fLegal']).toBe('It can be edited by Ada, and by document owners.');
    expect(who['pFaint']).toBe('It can be edited by document editors and owners.');
  });

  it('follows a change of access: the same issue becomes fixable once the scope grants edit', () => {
    const core = coreWith(documentWithIssues(), VIEWER);
    const before = runAccessibilityCheck(core, tr, nameOf)!;
    expect(before.issues.find((i) => i.issue.blockId === 'pJump')!.fix.fixable).toBe(false);
    core.permissions!.set(EDITOR);
    const after = runAccessibilityCheck(core, tr, nameOf)!;
    expect(after.issues.find((i) => i.issue.blockId === 'pJump')!.fix.fixable).toBe(true);
    expect(after.issues.find((i) => i.issue.blockId === 'fLegal')!.fix.fixable).toBe(false);
  });

  it('marks nothing fixable while the core has no access yet', () => {
    const result = runAccessibilityCheck(coreWith(documentWithIssues(), null), tr, nameOf)!;
    expect(result.issues.every((i) => !i.fix.fixable)).toBe(true);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
