/**
 * Citations and the bibliography (03 §4.7; EXP-121). Following the default of owner decision 10
 * (docs/owner-decisions-pending.md), the converter writes the citation texts and the bibliography
 * itself, in the two house styles of `settings.citationStyle` (`numeric`, `authorYear`), so biber
 * and `.bib` input never enter the sandbox. Every string still reaches TeX through the `text`
 * emitter, and URLs through `url`.
 *
 * The rules (ADR 0046, proposed):
 * - numeric: sources are numbered in the order they are first cited; a citation prints
 *   `[1]`, `[1, 3]`, `[see 2, p. 5]`; a narrative citation prints the authors before the number.
 * - authorYear: `(Family 2020)`, two authors `(A and B 2020)`, three or more `(A et al. 2020)`;
 *   several items are separated by `; `; narrative `Family (2020)`; suppressAuthor `(2020)`;
 *   equal labels get `a`, `b`, … after the year, in bibliography order.
 * - The bibliography lists the cited sources (`include: cited`) or every source (`all`): numeric in
 *   number order, author-year by first author, year and title.
 */
import { diag, str, type BibEntry, type Ctx, type J } from './context.ts';

interface Person {
  family?: string;
  given?: string;
  particle?: string;
  suffix?: string;
  literal?: string;
}

interface Item {
  source: string;
  prefix?: string;
  suffix?: string;
  locator?: string;
  label?: string;
}

const LOCATOR_ABBREVIATIONS: Readonly<Record<string, [string, string]>> = {
  page: ['p.', 'pp.'],
  chapter: ['ch.', 'chs.'],
  section: ['sec.', 'secs.'],
  paragraph: ['para.', 'paras.'],
  figure: ['fig.', 'figs.'],
  table: ['tab.', 'tabs.'],
  note: ['n.', 'nn.'],
  line: ['l.', 'll.'],
  verse: ['v.', 'vv.'],
  volume: ['vol.', 'vols.'],
  issue: ['no.', 'nos.'],
  part: ['pt.', 'pts.'],
  book: ['bk.', 'bks.'],
  column: ['col.', 'cols.'],
  equation: ['eq.', 'eqs.'],
  appendix: ['app.', 'apps.'],
  folio: ['fol.', 'fols.'],
  opus: ['op.', 'opp.'],
};

/** Kinds whose title is a whole work, set in italics; the others italicise the container. */
const WHOLE_WORKS = new Set([
  'book',
  'report',
  'thesis',
  'webpage',
  'dataset',
  'software',
  'manuscript',
  'map',
  'motion_picture',
  'musical_score',
  'pamphlet',
  'patent',
  'standard',
  'document',
  'collection',
  'periodical',
]);

function people(v: unknown): Person[] {
  return Array.isArray(v) ? (v.filter((p) => typeof p === 'object' && p !== null) as Person[]) : [];
}

function familyName(p: Person): string {
  if (p.literal) return p.literal;
  return [p.particle, p.family].filter(Boolean).join(' ') || p.given || '';
}

function fullName(p: Person, inverted: boolean): string {
  if (p.literal) return p.literal;
  const family = familyName(p);
  const given = p.given ?? '';
  const suffix = p.suffix ? `, ${p.suffix}` : '';
  if (!given) return family + suffix;
  return inverted ? `${family}, ${given}${suffix}` : `${given} ${family}${suffix}`;
}

function andList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function year(issued: unknown): string {
  const s = str(issued);
  return s ? s.slice(0, 4) : 'n.d.';
}

function authorLabel(src: J | undefined): string {
  const a = people(src?.attrs?.['authors']);
  const e = people(src?.attrs?.['editors']);
  const list = a.length ? a : e;
  if (list.length === 0) return str(src?.attrs?.['title']) ?? '?';
  const names = list.map(familyName);
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

function locatorText(item: Item): string {
  if (!item.locator) return '';
  const label = item.label ?? 'page';
  const abbr = Object.hasOwn(LOCATOR_ABBREVIATIONS, label)
    ? LOCATOR_ABBREVIATIONS[label]
    : undefined;
  const plural = /[-–,&]/.test(item.locator);
  const word = abbr ? abbr[plural ? 1 : 0] : label;
  return `${word} ${item.locator}`;
}

function sortKey(src: J): string {
  return `${authorLabel(src).toLowerCase()}\u0000${year(src.attrs?.['issued'])}\u0000${(str(src.attrs?.['title']) ?? '').toLowerCase()}`;
}

function entryParts(src: J, label: string | null, yearText: string | null): BibEntry['parts'] {
  const a = src.attrs ?? {};
  const out: Array<{ text: string; italic?: boolean; url?: string }> = [];
  const push = (text: string, extra: { italic?: boolean; url?: string } = {}): void => {
    if (text) out.push({ text, ...extra });
  };
  if (label) push(`${label} `);
  const authors = people(a['authors']);
  const editors = people(a['editors']);
  const names = authors.length ? authors : editors;
  if (names.length)
    push(
      andList(names.map((p, i) => fullName(p, i === 0))) +
        (authors.length === 0 ? (editors.length > 1 ? ' (eds.)' : ' (ed.)') : ''),
    );
  push(`${names.length ? ' ' : ''}(${yearText ?? year(a['issued'])}). `);
  const kind = str(a['kind']) ?? 'book';
  const title = str(a['title']);
  if (title)
    push(title.endsWith('.') ? `${title} ` : `${title}. `, { italic: WHOLE_WORKS.has(kind) });
  const container = str(a['containerTitle']);
  if (container) {
    if (authors.length && editors.length)
      push(
        `In ${andList(editors.map((p) => fullName(p, false)))} (${editors.length > 1 ? 'eds.' : 'ed.'}), `,
      );
    push(container, { italic: true });
    const vol = str(a['volume']);
    const issue = str(a['issue']);
    if (vol) push(`, ${vol}${issue ? `(${issue})` : ''}`);
    else if (issue) push(`, no. ${issue}`);
    const pages = str(a['pages']);
    if (pages) push(`, ${/[-–]/.test(pages) ? 'pp.' : 'p.'} ${pages}`);
    push('. ');
  }
  const edition = str(a['edition']);
  if (edition) push(`${edition} edn. `);
  const number = str(a['number']);
  if (number) push(`No. ${number}. `);
  const publisher = str(a['publisher']);
  const place = str(a['publisherPlace']);
  if (publisher || place) push(`${[place, publisher].filter(Boolean).join(': ')}. `);
  const doi = str(a['doi']);
  const url = str(a['url']);
  if (doi) push(`https://doi.org/${doi}`, { url: `https://doi.org/${doi}` });
  else if (url) push(url, { url });
  const accessed = str(a['accessed']);
  if (url && accessed) push(` (accessed ${accessed})`);
  // Trim the final separator.
  const last = out[out.length - 1];
  if (last && !last.url) last.text = last.text.replace(/\s+$/, '');
  return out;
}

/** Every citation's text in document order, and the bibliography entries. */
export function computeCitations(
  ctx: Pick<Ctx, 'diagnostics' | 'table'> & { doc: J },
  citations: ReadonlyArray<{ node: J; blockId: string | null }>,
  sources: ReadonlyMap<string, J>,
  include: 'cited' | 'all',
): { byNode: Map<J, string>; entries: BibEntry[] } {
  const style = str(
    (ctx.doc.content ?? [])
      .find((c) => c.type === 'defs')
      ?.content?.find((d) => d.type === 'settings')?.attrs?.['citationStyle'],
  );
  const numeric = style === 'numeric';
  // Order of first citation.
  const order: string[] = [];
  for (const { node, blockId } of citations) {
    for (const item of (node.attrs?.['items'] as Item[] | undefined) ?? []) {
      const id = str(item?.source);
      if (!id || !sources.has(id)) {
        diag(
          ctx as Ctx,
          'warning',
          'citation_source_missing',
          blockId,
          'a citation names a source that the document does not define; it prints [?]',
        );
        continue;
      }
      if (!order.includes(id)) order.push(id);
    }
  }
  const listed =
    include === 'all'
      ? [...order, ...[...sources.keys()].filter((k) => !order.includes(k))]
      : order;
  const numbers = new Map<string, number>();
  let entriesOrder: string[];
  if (numeric) {
    entriesOrder = listed;
    entriesOrder.forEach((id, i) => numbers.set(id, i + 1));
  } else {
    entriesOrder = [...listed].sort((x, y) => {
      const a = sortKey(sources.get(x)!);
      const b = sortKey(sources.get(y)!);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  // Author-year labels with a, b, … for equal labels.
  const ayLabel = new Map<string, { author: string; year: string }>();
  if (!numeric) {
    const groups = new Map<string, string[]>();
    for (const id of entriesOrder) {
      const src = sources.get(id)!;
      const key = `${authorLabel(src)}\u0000${year(src.attrs?.['issued'])}`;
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    for (const ids of groups.values())
      ids.forEach((id, i) => {
        const src = sources.get(id)!;
        const suffix = ids.length > 1 ? String.fromCharCode(97 + (i % 26)) : '';
        ayLabel.set(id, {
          author: authorLabel(src),
          year: `${year(src.attrs?.['issued'])}${suffix}`,
        });
      });
  }
  const byNode = new Map<J, string>();
  for (const { node } of citations) {
    const texts = { push: (s: string): void => void byNode.set(node, s) };
    const items = ((node.attrs?.['items'] as Item[] | undefined) ?? []).filter(
      (i) => typeof i === 'object' && i !== null,
    );
    const mode = str(node.attrs?.['mode']) ?? 'normal';
    const parts = items.map((item) => {
      const id = str(item.source) ?? '';
      const loc = locatorText(item);
      const pre = item.prefix ? `${item.prefix} ` : '';
      const post = item.suffix ? ` ${item.suffix}` : '';
      if (!sources.has(id)) return `${pre}?${post}`;
      if (numeric) return `${pre}${numbers.get(id)}${loc ? `, ${loc}` : ''}${post}`;
      const l = ayLabel.get(id)!;
      const who = mode === 'suppressAuthor' ? '' : `${l.author} `;
      return `${pre}${mode === 'narrative' ? '' : who}${l.year}${loc ? `, ${loc}` : ''}${post}`;
    });
    if (numeric) {
      const body = `[${parts.join(', ')}]`;
      if (mode === 'narrative') {
        const first = sources.get(str(items[0]?.source) ?? '');
        texts.push(`${first ? authorLabel(first) : '?'} ${body}`);
      } else texts.push(body);
    } else if (mode === 'narrative') {
      const first = items[0];
      const id = str(first?.source) ?? '';
      const l = ayLabel.get(id);
      texts.push(l ? `${l.author} (${parts.join('; ')})` : `? (${parts.join('; ')})`);
    } else texts.push(`(${parts.join('; ')})`);
  }
  const entries: BibEntry[] = entriesOrder.map((id) => ({
    sourceId: id,
    parts: entryParts(
      sources.get(id)!,
      numeric ? `[${numbers.get(id)}]` : null,
      numeric ? null : (ayLabel.get(id)?.year ?? null),
    ),
  }));
  return { byNode, entries };
}
