// The decided grammars against the prose (CDM-002, last criterion): ADR 0018 was accepted by the
// owner (decision 7 of docs/owner-decisions-2026-11-15.md) and 03 §4.8 now states its rules. This
// test reads that section and compares every value it gives with the definition, so the section and
// the code cannot drift apart. The per-attribute table (spec/cdm/cdm-1.attributes.md) is generated
// and checked by artifacts.test.ts; prose.test.ts checks the attribute names.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addDefs,
  bodyOf,
  codes,
  defsOf,
  exampleDoc,
  invariants,
  para,
  style,
  text,
} from '../../test/support.ts';
import { NODE_ID_PATTERN } from '../conventions/ids.ts';
import { COLOUR_PATTERN, MAX_INTEROPERABLE_INTEGER } from '../conventions/validators.ts';
import {
  BUILT_IN_STYLES,
  BULLET_CHARS,
  CDM1,
  DEFINITION_ID_PATTERN,
  EXT_KEY_PATTERN,
  FIELD_TARGET_PATTERN,
  HIGHLIGHT_VALUES,
  LINK_HREF_PATTERN,
} from '../definition/cdm1.ts';
import type { Grammar } from '../definition/grammar.ts';
import { newDocument } from '../structure/new-document.ts';

const root = resolve(import.meta.dirname, '../../../..');
const spec = readFileSync(resolve(root, 'docs/spec/03-document-model.md'), 'utf8');

/** The text of section 4.8, from its heading to the next heading. */
const section = ((): string => {
  const lines = spec.split('\n');
  const start = lines.findIndex((l) => /^### 4\.8 /.test(l));
  if (start < 0) throw new Error('03 has no section 4.8');
  let end = start + 1;
  while (end < lines.length && !/^#{2,3} /.test(lines[end]!)) end++;
  return lines.slice(start, end).join('\n');
})();

/** The rule of one topic: the second cell of the row whose first cell is `topic`. */
function rule(topic: string): string {
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1, -1).split(' | ');
    if (cells[0]?.trim() === topic) return cells.slice(1).join(' | ').trim();
  }
  throw new Error(`03 §4.8 has no row "${topic}"`);
}

/** The words in backticks, in order. */
const ticked = (s: string): string[] => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
/** The words in backticks between `label` and the next full stop or semicolon. */
function listed(text: string, label: string): string[] {
  const at = text.indexOf(label);
  if (at < 0) throw new Error(`"${label}" is not in: ${text}`);
  const rest = text.slice(at + label.length);
  const end = rest.search(/[.;](\s|$)/);
  return ticked(end < 0 ? rest : rest.slice(0, end));
}
/** `Heading1` to `Heading9` written out. */
function expandRanges(text: string): string {
  return text.replace(/`([A-Za-z]+)1` to `\1(\d)`/g, (_all, stem: string, last: string) =>
    Array.from({ length: Number(last) }, (_, i) => `\`${stem}${i + 1}\``).join(', '),
  );
}
const kib = (text: string, pattern: RegExp): number => {
  const m = pattern.exec(text);
  if (!m) throw new Error(`${pattern} is not in: ${text}`);
  return Number(m[1]) * 1024;
};
const number = (s: string): number => Number(s.replace(/,/g, ''));

const node = (name: string) => {
  const found = CDM1.nodes.find((n) => n.name === name);
  if (!found) throw new Error(`no node ${name}`);
  return found;
};
const mark = (name: string) => {
  const found = CDM1.marks.find((m) => m.name === name);
  if (!found) throw new Error(`no mark ${name}`);
  return found;
};
const grammarOf = (owner: { attrs: Readonly<Record<string, { grammar: Grammar }>> }, a: string) => {
  const found = owner.attrs[a];
  if (!found) throw new Error(`no attribute ${a}`);
  return found.grammar;
};
const values = (g: Grammar): string[] => {
  if (g.kind !== 'enum') throw new Error(`not an enumeration: ${g.kind}`);
  return [...g.values];
};
const member = (g: Grammar, name: string): Grammar => {
  if (g.kind !== 'object' || !g.properties[name]) throw new Error(`no member ${name}`);
  return g.properties[name];
};
const items = (g: Grammar): Grammar => {
  if (g.kind !== 'array') throw new Error(`not an array: ${g.kind}`);
  return g.items;
};
const range = (g: Grammar): [number, number] => {
  if (g.kind !== 'integer') throw new Error(`not an integer: ${g.kind}`);
  return [g.min, g.max];
};
const bytes = (g: Grammar): number => {
  if (g.kind !== 'json') throw new Error(`not free JSON: ${g.kind}`);
  return g.maxBytes;
};

describe('03 §4.8 against the definition (CDM-002; ADR 0018, accepted)', () => {
  it('names the decision record, the owner decision and the generated table', () => {
    expect(section).toContain('adr/0018-cdm-attribute-grammars.md');
    expect(section).toContain('owner-decisions-2026-11-15.md');
    expect(section).toContain('decision 7');
    expect(section).toContain('spec/cdm/cdm-1.attributes.md');
    const adr = readFileSync(resolve(root, 'docs/adr/0018-cdm-attribute-grammars.md'), 'utf8');
    expect(adr).toMatch(/^\*\*Status:\*\* accepted\./m);
    expect(adr).toContain('decision 7');
  });

  it('gives the alignment values of paragraphs, and of tables, figures and numbering levels', () => {
    const text = rule('Alignment');
    expect(listed(text, 'Paragraphs:')).toEqual(values(grammarOf(node('paragraph'), 'align')));
    expect(listed(text, 'Paragraphs:')).toEqual(values(grammarOf(node('style_def'), 'align')));
    const other = listed(text, 'Tables, figures and numbering levels:');
    expect(other).toEqual(values(grammarOf(node('table'), 'align')));
    expect(other).toEqual(values(grammarOf(node('figure'), 'align')));
    const level = items(grammarOf(node('numbering_def'), 'levels'));
    expect(other).toEqual(values(member(level, 'align')));
  });

  it('gives the alignments and leaders of tab stops', () => {
    const text = rule('Tab stops');
    const tab = items(grammarOf(node('paragraph'), 'tabs'));
    expect(listed(text, 'Alignment:')).toEqual(values(member(tab, 'align')));
    expect(listed(text, 'Leader:')).toEqual(values(member(tab, 'leader')));
  });

  it('gives the structure of borders and shading', () => {
    const text = rule('Borders');
    const sides = (owner: string): Grammar => grammarOf(node(owner), 'borders');
    const side = member(sides('paragraph'), 'top');
    const keys = (g: Grammar): string[] => Object.keys(g.kind === 'object' ? g.properties : {});
    /** `{ a, b }` in backticks, as the names it holds. */
    const members = (s: string): string[] => ticked(s)[0]!.replace(/[{} ]/g, '').split(',');
    expect(listed(text, 'Style:')).toEqual(values(member(side, 'style')));
    expect(members(text)).toEqual(keys(side));
    const width = /width is (\d+) to (\d+) twips/.exec(text)!;
    expect([Number(width[1]), Number(width[2])]).toEqual(range(member(side, 'width')));
    const space = /space is (\d+) to (\d+) twips/.exec(text)!;
    expect([Number(space[1]), Number(space[2])]).toEqual(range(member(side, 'space')));
    expect(member(side, 'color').nullable).toBe(true);
    expect(listed(text, 'A paragraph has the sides')).toEqual(keys(sides('paragraph')));
    expect(listed(text, 'a table has')).toEqual(keys(sides('table')));
    expect(keys(sides('table_cell'))).toEqual(['top', 'bottom', 'left', 'right']);
    expect(text).toContain('a cell has the four sides');
    for (const owner of ['paragraph', 'table_cell'])
      expect(keys(grammarOf(node(owner), 'shading')), owner).toEqual(members(rule('Shading')));
  });

  it('gives the value sets that 03 named without values', () => {
    const text = rule('Other value sets');
    expect(listed(text, 'Orientation:')).toEqual(
      values(grammarOf(node('page_setup'), 'orientation')),
    );
    expect(listed(text, 'Page number format:')).toEqual(
      values(grammarOf(node('page_setup'), 'pageNumberFormat')),
    );
    expect(listed(text, 'Footnote format:')).toEqual(
      values(grammarOf(node('settings'), 'footnoteFormat')),
    );
    expect(listed(text, 'Vertical alignment of a cell:')).toEqual(
      values(grammarOf(node('table_cell'), 'vAlign')),
    );
    expect(listed(text, 'Highlight:')).toEqual([...HIGHLIGHT_VALUES]);
    expect(listed(text, 'Highlight:')).toHaveLength(16);
    expect(values(grammarOf(mark('highlight'), 'value'))).toEqual([...HIGHLIGHT_VALUES]);
    expect(text).toContain('BCP 47');
  });

  it('writes out the built-in styles, each with its kind', () => {
    const text = expandRanges(rule('Built-in styles'));
    const written: Record<string, string> = {};
    for (const [label, kind] of [
      ['Paragraph styles:', 'paragraph'],
      ['Character styles:', 'character'],
      ['Table styles:', 'table'],
    ] as const)
      for (const id of listed(text, label)) written[id] = kind;
    expect(written).toEqual({ ...BUILT_IN_STYLES });
    expect(Object.keys(written)).toHaveLength(37);
  });

  it('writes out the published bullet list', () => {
    const text = rule('Bullets');
    const list = text
      .slice(text.indexOf(':') + 1)
      .trim()
      .split(' ');
    expect(list).toEqual([...BULLET_CHARS]);
    const level = items(grammarOf(node('numbering_def'), 'levels'));
    expect(values(member(level, 'bulletChar'))).toEqual([...BULLET_CHARS]);
  });

  it('gives the ranges of lengths and font sizes, inside the interoperable range', () => {
    const text = rule('Integers');
    const length = number(/at most ([\d,]+) twips/.exec(text)![1]!);
    expect(range(grammarOf(node('paragraph'), 'indentLeft'))).toEqual([-length, length]);
    expect(range(grammarOf(node('paragraph'), 'spaceBefore'))).toEqual([0, length]);
    expect(length).toBe(22 * 1440);
    const size = /Font sizes are ([\d,]+) to ([\d,]+) twips \((\d+) to ([\d,]+) points\)/.exec(
      text,
    )!;
    expect([number(size[1]!), number(size[2]!)]).toEqual(
      range(grammarOf(mark('fontSize'), 'value')),
    );
    expect([number(size[3]!) * 20, number(size[4]!) * 20]).toEqual([
      number(size[1]!),
      number(size[2]!),
    ]);
    expect(MAX_INTEROPERABLE_INTEGER).toBe(2 ** 53 - 1);
    expect(text).toContain('2^53 - 1');
  });

  it('fixes the letter case of colours', () => {
    expect(rule('Colours')).toContain('upper case');
    expect(new RegExp(COLOUR_PATTERN).test('#1A2B3C')).toBe(true);
    expect(new RegExp(COLOUR_PATTERN).test('#1a2b3c')).toBe(false);
    const d = exampleDoc();
    bodyOf(d).push(
      para('pColourLower0001', [text('x', [{ type: 'color', attrs: { value: '#1a2b3c' } }])]),
    );
    expect(invariants(d)).toEqual(['I11']);
  });

  it('counts string lengths in code points and refuses control characters but tab and line feed', () => {
    expect(rule('Strings')).toContain('code points');
    const withTitle = (title: string): string[] => {
      const d = exampleDoc();
      bodyOf(d).find((n) => n['type'] === 'region')!['attrs'].title = title;
      return codes(d);
    };
    // 255 characters outside the BMP are 510 UTF-16 units and still one maximal title.
    expect(withTitle('\u{1F600}'.repeat(255))).toEqual([]);
    expect(withTitle('\u{1F600}'.repeat(256))).not.toEqual([]);
    expect(withTitle('a\tb\nc')).toEqual([]);
    for (const control of ['\u0000', '\u0007', '\u000B', '\u001F', '\u007F', '\u0085', '\u009F'])
      expect(withTitle(`a${control}b`), JSON.stringify(control)).not.toEqual([]);
  });

  it('gives the form of definition identifiers, node identifiers and listId', () => {
    const def = rule('Definition identifiers');
    expect(def).toContain('1 to 64 characters');
    const id = new RegExp(DEFINITION_ID_PATTERN);
    for (const ok of ['ps1', 'Normal', 'a', 'x'.repeat(64), 'A_b-9'])
      expect(id.test(ok), ok).toBe(true);
    for (const bad of ['', 'x'.repeat(65), 'a b', 'a.b']) expect(id.test(bad), bad).toBe(false);
    expect(rule('Node identifiers')).toContain('16 characters');
    const nodeId = grammarOf(node('paragraph'), 'id');
    expect(nodeId).toMatchObject({ kind: 'string', maxLength: 16, pattern: NODE_ID_PATTERN });
    const numbering = grammarOf(node('paragraph'), 'numbering');
    expect(member(numbering, 'listId')).toMatchObject({ maxLength: 16, pattern: NODE_ID_PATTERN });
  });

  it('gives one form of field target for each kind, and the forms of a link target', () => {
    const forms = ticked(rule('Field targets')).filter((t) => /^[a-z]+:<[^>]+>$/.test(t));
    const prefixes = forms.map((f) => f.slice(0, f.indexOf(':')));
    expect(prefixes).toEqual(['bookmark', 'node', 'eq', 'style', 'field']);
    // The pattern has exactly these alternatives.
    expect([...FIELD_TARGET_PATTERN.matchAll(/(?:\(\?:|\|)([a-z]+):/g)].map((m) => m[1])).toEqual(
      prefixes,
    );
    const target = new RegExp(FIELD_TARGET_PATTERN);
    const samples: Record<string, string> = {
      bookmark: 'clause_4',
      node: 'p3Jq8sLw0aZx1VbN',
      eq: 'energy',
      style: 'Heading1',
      field: 'client.name',
    };
    for (const p of prefixes) expect(target.test(`${p}:${samples[p]}`), p).toBe(true);
    expect(target.test('clause_4')).toBe(false);

    const link = rule('Link targets');
    expect(ticked(link)).toEqual(['link.href', 'http', 'https', 'mailto', '#<name>']);
    const href = new RegExp(LINK_HREF_PATTERN);
    for (const ok of [
      'http://example.org/',
      'https://example.org/',
      'mailto:a@example.org',
      '#name',
    ])
      expect(href.test(ok), ok).toBe(true);
    expect(href.test('javascript:alert(1)')).toBe(false);
  });

  it('keeps bookmark names and equation labels unique', () => {
    expect(ticked(rule('Unique names'))).toEqual(['name', 'anchor', 'label']);
    const d = exampleDoc();
    const anchor = (id: string) => ({ type: 'anchor', attrs: { id, name: 'here' } });
    bodyOf(d).push(
      para('pTwoAnchors00001', [anchor('aAnchor000000001'), anchor('aAnchor000000002')]),
    );
    expect(codes(d)).toContain('duplicate_target_name');
  });

  it('gives the bounds of ext, of a recorded format and of extension payloads', () => {
    const ext = rule('The `ext` attribute');
    const g = grammarOf(node('paragraph'), 'ext');
    expect(g).toMatchObject({ kind: 'json', objectOnly: true, keyPattern: EXT_KEY_PATTERN });
    expect(kib(ext, /At most (\d+) KiB/)).toBe(bytes(g));
    expect(Number(/at most (\d+) levels deep/.exec(ext)![1])).toBe(
      g.kind === 'json' ? g.maxDepth : 0,
    );
    expect(new RegExp(EXT_KEY_PATTERN).test(ticked(ext)[0]!)).toBe(true);
    expect(ticked(ext)[0]).toBe('vendor.example:name');
    for (const owner of [...CDM1.nodes, ...CDM1.marks])
      if (owner.name !== 'text') expect(owner.attrs['ext']?.grammar, owner.name).toEqual(g);

    const before = rule('The `before` of a `fmt` suggestion');
    expect(kib(before, /at most (\d+) KiB/)).toBe(bytes(grammarOf(mark('fmt'), 'before')));

    const payloads = rule('Extension payloads');
    expect(kib(payloads, /At most (\d+) KiB on an `extension_block`/)).toBe(
      bytes(grammarOf(node('extension_block'), 'payload')),
    );
    expect(kib(payloads, /at most (\d+) KiB on an `extension_inline`/)).toBe(
      bytes(grammarOf(node('extension_inline'), 'payload')),
    );
  });

  it('refuses a number that is not an integer in ext and in a payload', () => {
    const d = exampleDoc();
    bodyOf(d).push(para('pExtFloat0000001', 'x', { ext: { 'vendor.example:ratio': 1.5 } }));
    expect(codes(d)).not.toEqual([]);
    const whole = exampleDoc();
    bodyOf(whole).push(para('pExtWhole0000001', 'x', { ext: { 'vendor.example:count': 2 } }));
    expect(codes(whole)).toEqual([]);
  });
});

describe('the two points of owner decision 7 (CDM-002)', () => {
  it('accepts a document that lacks a built-in style, and one that has them all', () => {
    // The example of 03 §12 defines two built-in styles of the 37.
    const d = exampleDoc();
    const defined = defsOf(d)
      .filter((n) => n['type'] === 'style_def')
      .map((n) => n['attrs'].id as string);
    expect(defined).toEqual(['Normal', 'Heading1']);
    expect(codes(d)).toEqual([]);
    // With no built-in style at all but its own default style, it is still valid.
    const bare = exampleDoc();
    const list = defsOf(bare);
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i]!['type'] === 'style_def') list.splice(i, 1);
    addDefs(bare, style('sOwnDefault00001', { kind: 'paragraph' }));
    defsOf(bare).find((n) => n['type'] === 'settings')!['attrs'].defaultParagraphStyle =
      'sOwnDefault00001';
    for (const n of bodyOf(bare)) {
      if (n['type'] === 'paragraph') n['attrs'].style = null;
      if (n['type'] === 'region')
        for (const p of n['content']) if (p.type === 'paragraph') p.attrs.style = null;
    }
    expect(codes(bare)).toEqual([]);
    // A new document made by the model has all 37, and is valid too.
    let made = 0;
    const fresh = newDocument({ newId: () => `nNew${String(++made).padStart(12, '0')}` });
    const builtIn = (fresh.doc.content?.[0]?.content ?? [])
      .filter((n) => n.type === 'style_def')
      .map((n) => (n.attrs as { id: string }).id);
    expect(builtIn.sort()).toEqual(Object.keys(BUILT_IN_STYLES).sort());
    expect(codes(fresh)).toEqual([]);
  });

  it('keeps a reserved identifier for the built-in style of its kind', () => {
    const wrongKind = exampleDoc();
    addDefs(wrongKind, style('Caption', { kind: 'character', builtIn: true }));
    expect(codes(wrongKind)).toContain('reserved_style_id');
    const notBuiltIn = exampleDoc();
    addDefs(notBuiltIn, style('Caption', { kind: 'paragraph' }));
    expect(codes(notBuiltIn)).toContain('reserved_style_id');
    const fine = exampleDoc();
    addDefs(fine, style('Caption', { kind: 'paragraph', builtIn: true, basedOn: 'Normal' }));
    expect(codes(fine)).toEqual([]);
  });

  it('lets validate() decide which nodes carry suggestions: three block types, and no block a mark', () => {
    const entry = { type: 'ins', attrs: { id: 'sSuggestion00001', user: 'u1' } };
    const ok = exampleDoc();
    bodyOf(ok).push(para('pSuggested000001', 'x', { suggest: [entry] }));
    expect(codes(ok)).toEqual([]);
    // A mark on a block is refused, whatever the mark (decision 7 as amended by decision 92).
    const marked = exampleDoc();
    bodyOf(marked).push({ ...para('pMarkedBlock0001'), marks: [entry] });
    expect(codes(marked)).toContain('node_mark_host');
    expect(invariants(marked)).toContain('I1');
    // Only a paragraph, a table row and a table have the attribute.
    const hosts = CDM1.nodes.filter((n) => 'suggest' in n.attrs).map((n) => n.name);
    expect(hosts.sort()).toEqual(['paragraph', 'table', 'table_row']);
  });
});
