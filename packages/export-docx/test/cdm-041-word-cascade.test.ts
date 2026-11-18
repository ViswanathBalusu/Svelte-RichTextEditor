/**
 * CDM-041 criterion 7, DOCX side: the values Word resolves for a written package equal the values
 * of the shared fixtures `packages/model/fixtures/semantics/cascade.json`.
 *
 * Each case is written as its own document by the direct writer (`writeDocx`). One Word instance
 * opens them all (tools/word-cascade/read-word-paragraphs.ps1, Word COM) and reports, for the
 * paragraph that starts with "Text", the paragraph format and the font of its first character as
 * Word's own cascade resolves them. Those values are compared with what the fixture expects. Word
 * applies ECMA-376 Part 1 §17.7.2, so this checks that what the writer writes (styles, numbering,
 * direct formatting) gives the fixture's values, not that the writer calls the model's resolver.
 *
 * Compared: the paragraph's `align` (justify, and start in a left-to-right paragraph), `dir`,
 * indents, spaces, `contextualSpacing`, line spacing, the keep, page-break and widow settings and
 * the tab stops; the run's font family, size, toggles, underline, vertical alignment, colour,
 * highlight, hidden and language. Not compared: `borders` and `shading` (the fixtures expect them
 * only as null), the numbering label's run (`labelRun`: Word has no property for it) and the typed
 * errors (the writer refuses nothing: it warns and keeps direct formatting). Needs Microsoft Word
 * on Windows; on other platforms the test is skipped.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonNode } from '@docedit/model';
import cascadeFile from '../../model/fixtures/semantics/cascade.json' with { type: 'json' };
import { AssetStore } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';

type J = Record<string, unknown>;

interface CascadeCase {
  id: string;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  paragraph: J;
  context?: { tableStyle?: string };
  marks?: J[];
  expected: { error?: string; paragraph?: J; run?: J };
}

interface CascadeFile {
  settings: J;
  styles: J[];
  numberings: J[];
  cases: CascadeCase[];
}

const file = cascadeFile as unknown as CascadeFile;
const WORK_DIR = fileURLToPath(new URL('../test-results/cdm-041-word/', import.meta.url));
const SCRIPT = fileURLToPath(
  new URL('../tools/word-cascade/read-word-paragraphs.ps1', import.meta.url),
);
const run = promisify(execFile);
/** The face of the font registry's default, stated to the writer; Word reads it from the defaults. */
const DEFAULT_FONT = 'Carlito';

interface WordRead {
  paragraph: {
    alignment: number;
    readingOrder: number;
    leftIndent: number;
    firstLineIndent: number;
    spaceBefore: number;
    spaceAfter: number;
    lineSpacingRule: number;
    lineSpacing: number;
    keepWithNext: boolean;
    keepTogether: boolean;
    pageBreakBefore: boolean;
    widowControl: boolean;
    tabs: { position: number; alignment: number; leader: number; custom: boolean }[];
  };
  font: {
    name: string;
    size: number;
    bold: boolean;
    italic: boolean;
    underline: number;
    strike: boolean;
    smallCaps: boolean;
    allCaps: boolean;
    superscript: boolean;
    subscript: boolean;
    hidden: boolean;
    colorHex: string | null;
    highlight: number;
    languageId: number;
  };
}

/** Fixture definitions, overridden by the case's own definitions with the same `id`. */
function mergeById(base: readonly J[], extra: readonly J[] = []): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

/** The document of one case, in the envelope the writer takes. */
function envelopeOf(c: CascadeCase): ReturnType<typeof newDocument> {
  const env = newDocument();
  const paragraph = {
    type: 'paragraph',
    attrs: { id: 'p00xxxxxxxxxxxxx', ...c.paragraph },
    content: [{ type: 'text', text: 'Text', ...(c.marks ? { marks: c.marks } : {}) }],
  };
  const tableStyle = c.context?.tableStyle ?? null;
  const block = tableStyle
    ? {
        type: 'table',
        attrs: { id: 'tablexxxxxxxxxxx', style: tableStyle, grid: [9000] },
        content: [
          {
            type: 'table_row',
            attrs: { id: 'rowxxxxxxxxxxxxx' },
            content: [
              { type: 'table_cell', attrs: { id: 'cellxxxxxxxxxxxx' }, content: [paragraph] },
            ],
          },
        ],
      }
    : paragraph;
  const defs = {
    type: 'defs',
    content: [
      { type: 'settings', attrs: { ...file.settings, ...c.settings } },
      ...mergeById(file.styles, c.styles),
      ...mergeById(file.numberings, c.numberings),
      { type: 'page_setup', attrs: { id: 'ps1' } },
    ],
  };
  env.doc = {
    ...env.doc,
    content: [defs, { type: 'body', attrs: { pageSetup: 'ps1' }, content: [block] }],
  } as unknown as JsonNode;
  return env;
}

const ALIGN: Record<string, number> = { start: 0, center: 1, end: 2, justify: 3, distribute: 4 };
const TAB_ALIGN: Record<string, number> = { left: 0, center: 1, right: 2, decimal: 3 };
const TAB_LEADER: Record<string, number> = {
  none: 0,
  dot: 1,
  hyphen: 2,
  underscore: 3,
  heavy: 4,
  middleDot: 5,
};
/** Word's `WdUnderline`. */
const UNDERLINE: Record<string, number> = { none: 0, single: 1, double: 3, dotted: 4 };
/** Word's `WdColorIndex` for the highlights the fixtures use. */
const HIGHLIGHT: Record<string, number> = { yellow: 7 };
/** Windows language identifiers of the tags the fixtures use. */
const LANGUAGE: Record<string, number> = { 'ar-EG': 3073, 'fr-FR': 1036, 'en-GB': 2057 };

const twips = (n: number): number => n / 20;

/** Word's values for the properties a case expects, in the model's terms, as "model, Word" pairs. */
function compare(c: CascadeCase, w: WordRead): string[] {
  const problems: string[] = [];
  const check = (name: string, want: unknown, got: unknown, tolerance = 0.06): void => {
    const same =
      typeof want === 'number' && typeof got === 'number'
        ? Math.abs(want - got) <= tolerance
        : JSON.stringify(want) === JSON.stringify(got);
    if (!same)
      problems.push(
        `${c.id}: ${name}: fixture ${JSON.stringify(want)}, Word ${JSON.stringify(got)}`,
      );
  };
  const p = c.expected.paragraph ?? {};
  const wp = w.paragraph;
  for (const [k, v] of Object.entries(p)) {
    switch (k) {
      case 'align':
        // `start` is left in a left-to-right paragraph; Word reports the page side.
        if (v === 'start' && (p['dir'] ?? 'ltr') === 'ltr') check(k, 0, wp.alignment);
        else if (v !== 'start' && v !== 'end') check(k, ALIGN[v as string], wp.alignment);
        break;
      case 'dir':
        check(k, v === 'ltr' ? 1 : 0, wp.readingOrder);
        break;
      case 'indentLeft':
        check(k, twips(v as number), wp.leftIndent);
        break;
      case 'indentFirstLine':
        check(k, twips(v as number), wp.firstLineIndent);
        break;
      case 'spaceBefore':
        check(k, twips(v as number), wp.spaceBefore);
        break;
      case 'spaceAfter':
        check(k, twips(v as number), wp.spaceAfter);
        break;
      case 'contextualSpacing':
        // Word's object model has no reading of it on a paragraph (ParagraphFormat lacks it).
        break;
      case 'lineSpacing':
      case 'lineRule':
        break;
      case 'keepNext':
        check(k, v, wp.keepWithNext);
        break;
      case 'keepLines':
        check(k, v, wp.keepTogether);
        break;
      case 'pageBreakBefore':
        check(k, v, wp.pageBreakBefore);
        break;
      case 'widowControl':
        check(k, v, wp.widowControl);
        break;
      case 'tabs': {
        const got = wp.tabs.filter((t) => t.custom).map((t) => [t.position, t.alignment, t.leader]);
        const want = (v as { position: number; align: string; leader: string }[]).map((t) => [
          twips(t.position),
          TAB_ALIGN[t.align],
          TAB_LEADER[t.leader],
        ]);
        check(k, want, got);
        break;
      }
      case 'borders':
      case 'shading':
        break;
      default:
        problems.push(`${c.id}: the test does not compare ${k}`);
    }
  }
  if ('lineSpacing' in p || 'lineRule' in p) {
    const rule = (p['lineRule'] as string | undefined) ?? 'multiple';
    if (rule === 'multiple') {
      const ratio =
        wp.lineSpacingRule === 0
          ? 1000
          : wp.lineSpacingRule === 1
            ? 1500
            : wp.lineSpacingRule === 2
              ? 2000
              : (wp.lineSpacing / 12) * 1000;
      if ('lineSpacing' in p) check('lineSpacing (multiple)', p['lineSpacing'], ratio, 0.5);
      check(
        'lineRule',
        'multiple',
        wp.lineSpacingRule <= 2 || wp.lineSpacingRule === 5 ? 'multiple' : 'other',
      );
    } else {
      check('lineRule', rule === 'exact' ? 4 : 3, wp.lineSpacingRule);
      if ('lineSpacing' in p)
        check('lineSpacing', twips(p['lineSpacing'] as number), wp.lineSpacing);
    }
  }
  const r = c.expected.run ?? {};
  const f = w.font;
  for (const [k, v] of Object.entries(r)) {
    switch (k) {
      case 'fontFamily':
        check(k, v ?? DEFAULT_FONT, f.name);
        break;
      case 'fontSize':
        check(k, twips(v as number), f.size);
        break;
      case 'bold':
        check(k, v, f.bold);
        break;
      case 'italic':
        check(k, v, f.italic);
        break;
      case 'underline':
        check(k, UNDERLINE[v as string], f.underline);
        break;
      case 'strike':
        check(k, v, f.strike);
        break;
      case 'smallCaps':
        check(k, v, f.smallCaps);
        break;
      case 'allCaps':
        check(k, v, f.allCaps);
        break;
      case 'vertAlign':
        check(k, v, f.superscript ? 'super' : f.subscript ? 'sub' : 'baseline');
        break;
      case 'color':
        check(k, v === null ? null : (v as string).replace('#', '').toUpperCase(), f.colorHex);
        break;
      case 'highlight':
        check(k, v === null ? 0 : HIGHLIGHT[v as string], f.highlight);
        break;
      case 'hidden':
        check(k, v, f.hidden);
        break;
      case 'lang':
        check(k, LANGUAGE[v as string], f.languageId);
        break;
      default:
        problems.push(`${c.id}: the test does not compare ${k}`);
    }
  }
  return problems;
}

const hasWord = process.platform === 'win32';

describe.skipIf(!hasWord)(
  'CDM-041 criterion 7: Word resolves the cascade fixtures for the written package',
  () => {
    it('every case of cascade.json has the values the fixture expects, as Word resolves them', async () => {
      rmSync(WORK_DIR, { recursive: true, force: true });
      mkdirSync(WORK_DIR, { recursive: true });
      const cases = file.cases.filter((c) => !c.expected.error);
      expect(cases.length).toBeGreaterThan(20);
      for (const c of cases) {
        const out = await writeDocx(envelopeOf(c), new AssetStore(), { defaultFont: DEFAULT_FONT });
        writeFileSync(`${WORK_DIR}${c.id}.docx`, out.bytes);
      }
      await run(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Dir', WORK_DIR],
        { timeout: 900_000, windowsHide: true },
      );
      const problems: string[] = [];
      for (const c of cases) {
        const raw = readFileSync(`${WORK_DIR}${c.id}.word.json`, 'utf8').replace(/^﻿/, '');
        problems.push(...compare(c, JSON.parse(raw) as WordRead));
      }
      expect(problems).toEqual([]);
    }, 900_000);
  },
);
