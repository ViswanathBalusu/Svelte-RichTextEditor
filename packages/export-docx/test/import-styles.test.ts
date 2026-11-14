/**
 * EXP-100, criteria 1, 2, 4 and 5 over the S11 corpus: paragraphs, text and marks come through as
 * CDM nodes, named styles keep their basedOn chains (built-in headings use the reserved identifiers
 * Heading1 to Heading9), the definitions get identifiers that are not taken from the file, and the
 * document defaults become a settings node with the default paragraph style. Criterion 3 (numbering
 * labels equal to those Word displays) needs Word and is not tested here.
 *
 * Criteria 1 and 2 are checked against the file itself: the run properties of `document.xml` and
 * the `w:basedOn` of `styles.xml`, read with the package's ZIP and XML readers, mapped through the
 * import's source map (CDM style id to Word style id).
 */
import { describe, expect, it } from 'vitest';
import type { JsonMark, JsonNode } from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { NS } from '../src/ooxml.ts';
import { attr, child, elements, parseXml, textContent, type XmlElement } from '../src/xml.ts';
import { readEntry, readZip } from '../src/zip.ts';
import { corpusFiles, readFile, type CorpusFile } from './corpus.ts';

const files = corpusFiles();

/** A part of a corpus file, parsed. */
function part(file: CorpusFile, name: string): XmlElement | undefined {
  const bytes = readEntry(readZip(readFile(file)), name);
  return bytes ? parseXml(bytes).root : undefined;
}

/** An OOXML on/off value (ST_OnOff): absent means on. */
const onOff = (el: XmlElement): boolean => {
  const v = attr(el, NS.w, 'val');
  return v === undefined || !['0', 'false', 'off'].includes(v);
};

/** The toggles of a run's own `w:rPr`, as CDM mark names (03 §5), and its character style. */
const TOGGLE_ELEMENTS: Readonly<Record<string, string>> = {
  b: 'bold',
  i: 'italic',
  strike: 'strike',
  caps: 'allCaps',
  smallCaps: 'smallCaps',
};

interface FileRun {
  text: string;
  toggles: Record<string, boolean>;
  /** The valued properties the CDM has a mark for (03 §5), as the mark's `value` or `style`. */
  valued: Record<string, string | number>;
  rStyle: string | undefined;
}

/**
 * The CDM value of a valued run property, or undefined when the model has none for it (it is then
 * preserved, not a mark): `w:sz` in half points to tenths of a point, `w:color` as `#RRGGBB`,
 * `w:vertAlign` and `w:u` from the values the model names.
 */
function valuedMark(p: XmlElement): [string, string | number] | undefined {
  const val = attr(p, NS.w, 'val');
  if (val === undefined) return undefined;
  switch (p.local) {
    case 'sz': {
      const half = /^\d+$/.test(val) ? Number(val) : NaN;
      return half >= 2 && half <= 3276 ? ['fontSize', half * 10] : undefined;
    }
    case 'color':
      // A theme colour is kept with the run as preserved formatting; the RGB value is the mark.
      return /^[0-9A-Fa-f]{6}$/.test(val) ? ['color', `#${val.toUpperCase()}`] : undefined;
    case 'vertAlign': {
      const v = (
        { superscript: 'super', subscript: 'sub', baseline: 'baseline' } as Record<string, string>
      )[val];
      return v ? ['vertAlign', v] : undefined;
    }
    case 'u':
      return ['single', 'double', 'dotted', 'none'].includes(val) ? ['underline', val] : undefined;
    default:
      return undefined;
  }
}

/**
 * The text of the runs of the main document part, one entry per `w:t` or `w:delText`, in document
 * order, with the toggles and character style of the run's own `w:rPr`. Text boxes, drawings and
 * alternate content are left out: the import keeps them as preserved atoms.
 */
function fileRuns(root: XmlElement): FileRun[] {
  const out: FileRun[] = [];
  const skip = new Set(['txbxContent', 'drawing', 'pict', 'object', 'AlternateContent']);
  // An explicit stack, in document order: some corpus files nest deeper than the call stack.
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (skip.has(el.local)) continue;
    if (el.ns === NS.w && el.local === 'r') {
      const rPr = child(el, NS.w, 'rPr');
      const toggles: Record<string, boolean> = {};
      const valued: Record<string, string | number> = {};
      let rStyle: string | undefined;
      for (const p of rPr ? elements(rPr) : []) {
        if (p.ns !== NS.w) continue;
        const mark = TOGGLE_ELEMENTS[p.local];
        if (mark) toggles[mark] = onOff(p);
        const v = valuedMark(p);
        if (v) valued[v[0]] = v[1];
        if (p.local === 'rStyle') rStyle = attr(p, NS.w, 'val');
      }
      for (const c of elements(el))
        if (c.ns === NS.w && (c.local === 't' || c.local === 'delText')) {
          const text = textContent(c);
          if (text) out.push({ text, toggles, valued, rStyle });
        }
      continue;
    }
    const kids = elements(el);
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]!);
  }
  return out;
}

/** The text nodes of the imported body, in order, footnotes left out (they come from another part). */
function importedText(doc: JsonNode): Array<{ text: string; marks: readonly JsonMark[] }> {
  const out: Array<{ text: string; marks: readonly JsonMark[] }> = [];
  const visit = (n: JsonNode): void => {
    if (n.type === 'footnote') return;
    if (n.type === 'text' && typeof n.text === 'string')
      out.push({ text: n.text, marks: n.marks ?? [] });
    for (const c of n.content ?? []) visit(c);
  };
  const body = (doc.content ?? []).find((n) => n.type === 'body');
  if (body) visit(body);
  return out;
}

function walk(n: JsonNode, visit: (node: JsonNode) => void): void {
  visit(n);
  for (const c of n.content ?? []) walk(c, visit);
}

function nodes(doc: JsonNode): { defs: JsonNode[]; body: JsonNode[]; all: JsonNode[] } {
  const all: JsonNode[] = [];
  walk(doc, (n) => all.push(n));
  const defs = (doc.content ?? []).find((n) => n.type === 'defs')?.content ?? [];
  return { defs, body: all, all };
}

describe.each(files)('$name', (file) => {
  it('criterion 1: paragraphs and text arrive as CDM nodes (marks: see below)', async () => {
    const imported = await importDocx(readFile(file));
    const { body } = nodes(imported.envelope.doc as JsonNode);
    expect(body.some((n) => n.type === 'paragraph')).toBe(true);
    // Every text node carries text, as the CDM requires.
    for (const n of body)
      if (n.type === 'text') expect(typeof n.text === 'string' && n.text.length > 0).toBe(true);
  });

  it('criterion 2: every basedOn names a style in the document, and a built-in heading is Heading<n>', async () => {
    const imported = await importDocx(readFile(file));
    const { defs } = nodes(imported.envelope.doc as JsonNode);
    const styleIds = new Set(
      defs.filter((d) => d.type === 'style_def').map((d) => d.attrs?.['id']),
    );
    for (const d of defs) {
      if (d.type !== 'style_def') continue;
      const base = d.attrs?.['basedOn'];
      if (typeof base === 'string') expect(styleIds.has(base), `basedOn ${base}`).toBe(true);
      const id = d.attrs?.['id'];
      if (typeof id === 'string' && /^Heading\d$/.test(id)) {
        expect(d.attrs?.['kind']).toBe('paragraph');
        expect(d.attrs?.['builtIn']).toBe(true);
        expect(Number(id.slice(7))).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('criterion 4: definition identifiers are unique and are not the file identifiers of the same definition', async () => {
    const imported = await importDocx(readFile(file));
    const { defs } = nodes(imported.envelope.doc as JsonNode);
    const ids = defs
      .map((d) => d.attrs?.['id'])
      .filter((id): id is string => typeof id === 'string');
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of defs) {
      if (d.type !== 'style_def' && d.type !== 'numbering_def') continue;
      const id = d.attrs?.['id'];
      // Reserved built-in identifiers are the model's; any other one is random (a 16-character identifier).
      if (typeof id === 'string' && !d.attrs?.['builtIn'])
        expect(id, 'random identifier').toMatch(/^[A-Za-z0-9_-]{16}$/);
    }
  });

  it('criterion 5: the document defaults become one settings node that names a paragraph style', async () => {
    const imported = await importDocx(readFile(file));
    const { defs } = nodes(imported.envelope.doc as JsonNode);
    const settings = defs.filter((d) => d.type === 'settings');
    expect(settings.length).toBeLessThanOrEqual(1);
    const def = settings[0]?.attrs?.['defaultParagraphStyle'];
    if (def !== undefined) {
      const style = defs.find((d) => d.type === 'style_def' && d.attrs?.['id'] === def);
      expect(style?.attrs?.['kind'], 'default paragraph style').toBe('paragraph');
    }
  });
});

describe('criterion 1: the marks of imported text are those of the file’s runs', () => {
  it('gives each imported text the marks of its run’s w:rPr, on every corpus file', async () => {
    let compared = 0;
    let marked = 0;
    const filesWithMarks = new Set<string>();
    for (const file of files) {
      const imported = await importDocx(readFile(file));
      const main = part(file, imported.sourceMap.mainPart);
      expect(main, file.name).toBeDefined();
      const runs = fileRuns(main!);
      const texts = importedText(imported.envelope.doc as JsonNode);
      const wordStyles = new Set(Object.values(imported.sourceMap.styles));
      // Each imported text is a run's text, in document order: the runs the import keeps as atoms
      // (hyperlinks, fields, content controls, runs it cannot model) are skipped over.
      let at = 0;
      for (const t of texts) {
        while (at < runs.length && runs[at]!.text !== t.text) at++;
        expect(
          at < runs.length,
          `${file.name}: imported text ${JSON.stringify(t.text)} not found in order`,
        ).toBe(true);
        const run = runs[at++]!;
        compared++;
        const got: Record<string, boolean> = {};
        const gotValued: Record<string, string | number> = {};
        let charStyle: string | undefined;
        for (const m of t.marks) {
          if (Object.values(TOGGLE_ELEMENTS).includes(m.type))
            got[m.type] = m.attrs?.['value'] !== false;
          if (['fontSize', 'color', 'vertAlign'].includes(m.type))
            gotValued[m.type] = m.attrs?.['value'] as string | number;
          if (m.type === 'underline') gotValued[m.type] = String(m.attrs?.['style']);
          if (m.type === 'charStyle') charStyle = String(m.attrs?.['style']);
        }
        expect(got, `${file.name}: toggles of ${JSON.stringify(t.text)}`).toEqual(run.toggles);
        expect(gotValued, `${file.name}: valued marks of ${JSON.stringify(t.text)}`).toEqual(
          run.valued,
        );
        // The character style is the file's, through the import's identifier mapping. A w:rStyle
        // that names no style of the file has no style_def to point at, so it gives no mark.
        expect(
          charStyle === undefined ? undefined : imported.sourceMap.styles[charStyle],
          `${file.name}: charStyle of ${JSON.stringify(t.text)}`,
        ).toBe(run.rStyle !== undefined && wordStyles.has(run.rStyle) ? run.rStyle : undefined);
        if (
          Object.keys(got).length > 0 ||
          Object.keys(gotValued).length > 0 ||
          charStyle !== undefined
        ) {
          marked++;
          filesWithMarks.add(file.name);
        }
      }
    }
    // Not vacuous: hundreds of texts compared, and marked text in many files (917 texts, 144 of
    // them marked, in 17 files, in the run of 2026-11-13).
    expect(compared).toBeGreaterThan(500);
    expect(marked).toBeGreaterThan(100);
    expect(filesWithMarks.size).toBeGreaterThanOrEqual(15);
  });

  it('imports bold and italic text of a file as bold and italic marks', async () => {
    // A file of the corpus with both: find the first one, so the test does not depend on a name.
    for (const file of files) {
      const main = part(file, 'word/document.xml');
      if (!main) continue;
      const runs = fileRuns(main);
      const bold = runs.find((r) => r.toggles['bold'] === true && !r.toggles['italic']);
      const italic = runs.find((r) => r.toggles['italic'] === true && !r.toggles['bold']);
      if (!bold || !italic) continue;
      const texts = importedText((await importDocx(readFile(file))).envelope.doc as JsonNode);
      const has = (text: string, type: string) =>
        texts.some(
          (t) =>
            t.text === text && t.marks.some((m) => m.type === type && m.attrs?.['value'] !== false),
        );
      expect(has(bold.text, 'bold'), `${file.name}: ${bold.text}`).toBe(true);
      expect(has(italic.text, 'italic'), `${file.name}: ${italic.text}`).toBe(true);
      return;
    }
    throw new Error('no corpus file has both bold and italic runs');
  });
});

describe('criterion 2: the basedOn chain of the file’s styles is kept', () => {
  it('gives every imported style the basedOn of its Word style, through the identifier mapping', async () => {
    let kept = 0;
    let headings = 0;
    const filesWithBasedOn = new Set<string>();
    for (const file of files) {
      const imported = await importDocx(readFile(file));
      const stylesPart = imported.sourceMap.stylesPart;
      const root = stylesPart ? part(file, stylesPart) : undefined;
      if (!root) continue;
      const cdmOf = new Map(
        Object.entries(imported.sourceMap.styles).map(([cdm, word]) => [word, cdm]),
      );
      const defs =
        (imported.envelope.doc as JsonNode).content?.find((n) => n.type === 'defs')?.content ?? [];
      const def = new Map(
        defs.filter((d) => d.type === 'style_def').map((d) => [String(d.attrs?.['id']), d]),
      );
      const seen = new Set<string>();
      const headingTaken = new Set<string>();
      for (const el of elements(root)) {
        if (el.ns !== NS.w || el.local !== 'style') continue;
        const kind = attr(el, NS.w, 'type') ?? 'paragraph';
        const wordId = attr(el, NS.w, 'styleId');
        if (!wordId || seen.has(wordId) || !['paragraph', 'character', 'table'].includes(kind))
          continue;
        seen.add(wordId);
        const id = cdmOf.get(wordId);
        expect(id, `${file.name}: style ${wordId} imported`).toBeDefined();
        const node = def.get(id!);
        expect(node, `${file.name}: style_def for ${wordId}`).toBeDefined();
        const baseEl = child(el, NS.w, 'basedOn');
        const base = baseEl ? attr(baseEl, NS.w, 'val') : undefined;
        const expected = base === undefined ? undefined : cdmOf.get(base);
        expect(node!.attrs?.['basedOn'], `${file.name}: basedOn of ${wordId} (${base})`).toBe(
          expected,
        );
        if (expected !== undefined) {
          kept++;
          filesWithBasedOn.add(file.name);
        }
        // A built-in heading keeps its basedOn chain under its reserved identifier.
        const nameEl = child(el, NS.w, 'name');
        const name = (nameEl ? attr(nameEl, NS.w, 'val') : '')?.toLowerCase() ?? '';
        const m = /^heading ([1-9])$/.exec(name);
        if (m && kind === 'paragraph' && !headingTaken.has(m[1]!)) {
          // The first paragraph style named "heading n" takes the reserved identifier Heading<n>.
          headingTaken.add(m[1]!);
          headings++;
          expect(id, `${file.name}: ${wordId}`).toBe(`Heading${m[1]}`);
          expect(node!.attrs?.['builtIn'], `${file.name}: ${id}`).toBe(true);
        }
      }
    }
    // Not vacuous: most corpus files have basedOn chains, and some have Word headings.
    expect(filesWithBasedOn.size).toBeGreaterThanOrEqual(60);
    expect(kept).toBeGreaterThan(200);
    expect(headings).toBeGreaterThan(5);
  });
});

describe('criterion 1: formatting with no CDM property is reported', () => {
  it('reports the formatting the editor does not show in a file that has some', async () => {
    const imported = await importDocx(
      readFile(corpusFiles().find((f) => f.name === 'poi/sample.docx')!),
    );
    const item = imported.report.find((i) => i.kind === 'formatting the editor does not show');
    expect(item?.count).toBeGreaterThan(0);
  });
});

describe('the heading styles of a file with Word headings', () => {
  it('maps Heading1 to Heading3 to the reserved identifiers', async () => {
    const imported = await importDocx(
      readFile(corpusFiles().find((f) => f.name === 'poi/heading123.docx')!),
    );
    const { defs } = nodes(imported.envelope.doc as JsonNode);
    const ids = defs.filter((d) => d.type === 'style_def').map((d) => d.attrs?.['id']);
    expect(ids).toEqual(expect.arrayContaining(['Heading1', 'Heading2', 'Heading3']));
  });
});
