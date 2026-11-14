/**
 * The criteria of EXP-092 (page structure, notes and references) and EXP-094 (regions) that the
 * direct writer's feature test (test/writer.test.ts) does not check on their own: the page size and
 * margins of every section, one paragraph per footnote, the region tags and titles, the editable
 * ranges with and without the host's callbacks, and the case where every region is editable.
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { writerDocs, type WriterDoc } from './writer-docs.ts';

const docs = await writerDocs();
const doc = (name: string): WriterDoc => docs.find((d) => d.name === name)!;

function partsOf(bytes: Uint8Array): Map<string, string> {
  const zip = readZip(bytes);
  const out = new Map<string, string>();
  for (const e of zip.entries) {
    if (!/\.xml$/.test(e.name)) continue;
    out.set(e.name, new TextDecoder().decode(entryData(zip, e)));
  }
  return out;
}

const xml = (text: string): XmlElement => parseXml(new TextEncoder().encode(text)).root;

function all(root: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.local === local) out.push(e);
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c.kind === 'element') stack.push(c);
    }
  }
  return out;
}

const att = (e: XmlElement | undefined, local: string): string | undefined =>
  e?.attrs.find((a) => a.local === local)?.value;

const kid = (e: XmlElement | undefined, local: string): XmlElement | undefined =>
  e?.children.find((c): c is XmlElement => c.kind === 'element' && c.local === local);

/** The top-level children of a node of the document, by type. */
const childrenOf = (n: JsonNode | undefined, type: string): JsonNode[] =>
  (n?.content ?? []).filter((c) => c.type === type);

function bodyOf(d: WriterDoc): JsonNode {
  const root = d.envelope.doc as JsonNode;
  return childrenOf(root, 'body')[0]!;
}

describe('EXP-092 criterion 1: sections keep their size, margins and columns', () => {
  it('writes each section with the size its page setup gives, and margins on every section', async () => {
    const d = doc('sections-notes-fields');
    const out = await writeDocx(d.envelope, d.assets, { title: 'Title' });
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const sects = all(body, 'sectPr');
    expect(sects.length).toBe(2);
    const defs = childrenOf(d.envelope.doc as JsonNode, 'defs')[0];
    const setups = childrenOf(defs, 'page_setup').map((s) => s.attrs ?? {});
    // The second setup gives its size, and it is landscape: the section is wider than it is high.
    const sized = setups.find((v) => typeof v['width'] === 'number');
    expect(sized).toBeDefined();
    const landscape = sects.find((s) => att(kid(s, 'pgSz'), 'orient') === 'landscape')!;
    expect(att(kid(landscape, 'pgSz'), 'w')).toBe(String(sized!['width']));
    expect(att(kid(landscape, 'pgSz'), 'h')).toBe(String(sized!['height']));
    expect(Number(att(kid(landscape, 'pgSz'), 'w'))).toBeGreaterThan(
      Number(att(kid(landscape, 'pgSz'), 'h')),
    );
    // A setup that gives no size or margins takes the writer's defaults (observed: A4 in twips and
    // 1440 twips margins). Every section carries a size and four margins.
    const portrait = sects.find((s) => s !== landscape)!;
    expect(att(kid(portrait, 'pgSz'), 'w')).toBe('11906');
    expect(att(kid(portrait, 'pgSz'), 'h')).toBe('16838');
    for (const s of sects) {
      const pgMar = kid(s, 'pgMar');
      for (const side of ['top', 'right', 'bottom', 'left'])
        expect(Number(att(pgMar, side))).toBeGreaterThan(0);
      expect(att(pgMar, 'left')).toBe('1440');
    }
    expect(att(kid(landscape, 'cols'), 'num')).toBe('2');
  });
});

describe('EXP-092 criterion 2: a footnote is a Word footnote of one paragraph', () => {
  it('writes the note of the fixture as one paragraph in the footnotes part', async () => {
    const d = doc('sections-notes-fields');
    const out = await writeDocx(d.envelope, d.assets);
    const notes = xml(partsOf(out.bytes).get('word/footnotes.xml')!);
    const real = all(notes, 'footnote').filter((f) => att(f, 'id') === '1');
    expect(real.length).toBe(1);
    expect(all(real[0]!, 'p').length).toBe(1);
    // The model side: the footnote node holds one paragraph too.
    const note = childrenOf(bodyOf(d), 'paragraph')
      .flatMap((p) => p.content ?? [])
      .find((n) => n.type === 'footnote');
    expect(note, 'the fixture has a footnote').toBeDefined();
    expect((note?.content ?? []).length).toBe(1);
  });
});

describe('EXP-092 criterion 5: tab stops, watermark and page numbering are native properties', () => {
  it('writes the tab stops of the paragraph that holds them as w:tabs', async () => {
    const d = docs.find((x) => x.texts.includes('after a tab'))!;
    const out = await writeDocx(d.envelope, d.assets);
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const tabs = all(body, 'tabs').flatMap((t) =>
      t.children.filter((c): c is XmlElement => c.kind === 'element'),
    );
    expect(
      tabs.some(
        (t) =>
          t.local === 'tab' &&
          att(t, 'val') === 'right' &&
          att(t, 'pos') === '2880' &&
          att(t, 'leader') === 'dot',
      ),
    ).toBe(true);
  });

  it('writes the watermark in a header, and the page number start and format on the section', async () => {
    const d = doc('sections-notes-fields');
    const out = await writeDocx(d.envelope, d.assets, { title: 'Title' });
    const parts = partsOf(out.bytes);
    const headers = [...parts].filter(([k]) => /^word\/header\d+\.xml$/.test(k)).map(([, v]) => v);
    expect(headers.some((h) => h.includes('string="DRAFT"'))).toBe(true);
    const first = all(xml(parts.get('word/document.xml')!), 'sectPr')[0]!;
    const pgNum = kid(first, 'pgNumType');
    expect(att(pgNum, 'fmt')).toBe('lowerRoman');
    expect(att(pgNum, 'start')).toBe('3');
  });
});

describe('EXP-094 criterion 1: a region is a block-level content control tagged with its id and titled', () => {
  it('writes one block content control per region with the region identifier and title', async () => {
    const d = doc('regions-forms');
    const out = await writeDocx(d.envelope, d.assets);
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const regions = childrenOf(bodyOf(d), 'region');
    expect(regions.length).toBeGreaterThanOrEqual(2);
    for (const r of regions) {
      const id = String(r.attrs?.['id']);
      const sdts = all(body, 'sdt').filter(
        (s) => kid(kid(s, 'sdtPr'), 'tag') && att(kid(kid(s, 'sdtPr'), 'tag'), 'val') === id,
      );
      expect(sdts.length, `control of ${id}`).toBe(1);
      // Block-level: the control is a child of the body, never of a paragraph.
      expect(sdts[0]!.parent?.local).toBe('body');
      if (typeof r.attrs?.['title'] === 'string')
        expect(att(kid(kid(sdts[0]!, 'sdtPr'), 'alias'), 'val')).toContain(r.attrs['title']);
    }
  });
});

describe('EXP-094 criteria 2 and 3: protection and editable ranges follow the host callbacks', () => {
  it('adds no protection when every region is editable by everyone', async () => {
    const d = doc('regions-forms');
    const out = await writeDocx(d.envelope, d.assets, {
      regionEditableByEveryone: () => true,
      regionEditors: () => ['someone@example.com'],
    });
    // The fixture holds form fields, which give their own form protection (EXP-095); the region
    // protection, read-only with editable ranges, must not be added.
    const parts = partsOf(out.bytes);
    expect(parts.get('word/settings.xml')).not.toContain('w:edit="readOnly"');
    expect(parts.get('word/document.xml')).not.toContain('permStart');
    expect(out.warnings.some((w) => w.includes('document protection is advisory'))).toBe(false);
  });

  it('writes the everyone group only when the host gives no export identities', async () => {
    const d = doc('regions-forms');
    const regions = childrenOf(bodyOf(d), 'region').map((r) => String(r.attrs?.['id']));
    const locked = regions[0]!;
    const out = await writeDocx(d.envelope, d.assets, {
      regionEditableByEveryone: (id) => id !== locked,
    });
    const parts = partsOf(out.bytes);
    expect(parts.get('word/settings.xml')).toContain('w:edit="readOnly"');
    // EXP-094 criterion 6: the warning says the protection is advisory and enforced only inside the service.
    expect(
      out.warnings.some(
        (w) => w.includes('document protection is advisory') && w.includes('document service'),
      ),
    ).toBe(true);
    const perms = all(xml(parts.get('word/document.xml')!), 'permStart');
    expect(perms.some((p) => att(p, 'ed') !== undefined)).toBe(false);
    expect(perms.every((p) => att(p, 'edGrp') === 'everyone')).toBe(true);
  });

  it('writes per-user ranges for the identities the callback names, for the restricted region only', async () => {
    const d = doc('regions-forms');
    const regions = childrenOf(bodyOf(d), 'region').map((r) => String(r.attrs?.['id']));
    const locked = regions[0]!;
    const out = await writeDocx(d.envelope, d.assets, {
      regionEditableByEveryone: (id) => id !== locked,
      regionEditors: (id) => (id === locked ? ['alice@example.com'] : []),
    });
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const named = all(body, 'permStart').filter((p) => att(p, 'ed') !== undefined);
    expect(named.map((p) => att(p, 'ed'))).toEqual(['alice@example.com']);
    // The editable range sits beside the locked region's own control: its start precedes the control
    // and its end follows it, as siblings in the body.
    const lockedSdt = all(body, 'sdt').find(
      (s) => att(kid(kid(s, 'sdtPr'), 'tag'), 'val') === locked,
    );
    const siblings = lockedSdt?.parent?.children.filter(
      (c): c is XmlElement => c.kind === 'element',
    );
    const at = siblings?.indexOf(lockedSdt!) ?? -1;
    expect(at).toBeGreaterThan(0);
    expect(siblings![at - 1]?.local).toBe('permStart');
    expect(att(siblings![at - 1], 'ed')).toBe('alice@example.com');
    expect(siblings![at + 1]?.local).toBe('permEnd');
  });
});
