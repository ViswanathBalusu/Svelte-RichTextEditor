/**
 * EXP-095, criterion 1: every form field becomes an inline content control bound to the values
 * part, including checkbox and date fields, which the writer used to leave unbound. Each binding's
 * XPath must point at the field of its own key in the values part.
 */
import { describe, expect, it } from 'vitest';
import { entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { writerDocs, type WriterDoc } from './writer-docs.ts';

const docs = await writerDocs();
const doc = (name: string): WriterDoc => docs.find((d) => d.name === name)!;

const all = (root: XmlElement, local: string): XmlElement[] => {
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
};
const att = (e: XmlElement | undefined, local: string): string | undefined =>
  e?.attrs.find((a) => a.local === local)?.value;
const text = (e: XmlElement): string =>
  e.children
    .map((c) => (c.kind === 'text' ? c.value : c.kind === 'element' ? text(c) : ''))
    .join('');

function parts(bytes: Uint8Array): Map<string, string> {
  const zip = readZip(bytes);
  const out = new Map<string, string>();
  for (const e of zip.entries)
    if (/\.(xml|rels)$/.test(e.name)) out.set(e.name, new TextDecoder().decode(entryData(zip, e)));
  return out;
}

describe('EXP-095 form-field bindings', () => {
  it('binds every form field, checkbox and date included, to its own key in the values part', async () => {
    const d = doc('regions-forms');
    const p = parts((await writeDocx(d.envelope, d.assets)).bytes);
    const body = parseXml(new TextEncoder().encode(p.get('word/document.xml')!)).root;
    const controls = all(body, 'sdt').filter((s) =>
      all(s, 'tag').some((t) => att(t, 'val')?.startsWith('tenant.')),
    );
    expect(controls.length).toBe(6);
    const item = [...p]
      .map(([k, v]) => [k, v] as const)
      .find(([k, v]) => /^customXml\/item\d+\.xml$/.test(k) && v.includes('f:fields'))!;
    const values = parseXml(new TextEncoder().encode(item[1])).root;
    const fields = all(values, 'field');
    for (const c of controls) {
      const binding = all(c, 'dataBinding')[0];
      expect(binding, `control ${att(all(c, 'tag')[0], 'val')} has no binding`).toBeDefined();
      const xpath = att(binding, 'xpath')!;
      const index = Number(/field\[(\d+)\]$/.exec(xpath)![1]);
      const field = fields[index - 1];
      expect(att(field, 'key')).toBe(att(all(c, 'tag')[0], 'val'));
    }
  });

  it('stores a checkbox as true or false, and a date as a dateTime, in the values part', async () => {
    const d = doc('regions-forms');
    const p = parts((await writeDocx(d.envelope, d.assets)).bytes);
    const item = [...p].find(
      ([k, v]) => /^customXml\/item\d+\.xml$/.test(k) && v.includes('f:fields'),
    )!;
    const values = parseXml(new TextEncoder().encode(item[1])).root;
    const byKey = new Map(all(values, 'field').map((f) => [att(f, 'key'), text(f)]));
    const agrees = byKey.get('tenant.agrees');
    expect(agrees === 'true' || agrees === 'false' || agrees === '').toBe(true);
    const since = byKey.get('tenant.since');
    expect(since === '' || /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(since!)).toBe(true);
  });
});
