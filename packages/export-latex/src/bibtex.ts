/**
 * The `.bib` file and the biblatex commands (09 §3, §4, §9.3; EXP-121; owner decision 16). The
 * sources of the document become `references.bib`, written only through the `bibField` and `bibKey`
 * emitters, so no user string reaches biber or TeX unescaped; the citations become biblatex
 * commands with the same keys; and the bibliography node prints through `\printbibliography`.
 *
 * The converter's own text route (`citations.ts`) stays for `bibliography: 'text'` and for the
 * text of a citation whose sources are all missing. Which route a document takes is decided in
 * `convert.ts`; this module only writes what the biblatex route needs.
 *
 * The mapping from the model's source kinds to biblatex entry types is a proposal (ADR 0433).
 */
import { bibField, bibKey, bibVerbatim, EMPTY, join, lit, text, tex, type Tex } from './emit.ts';
import { locatorText } from './citations.ts';
import type { J } from './context.ts';

/** The citation styles a job can ask for (owner decision 126; ADR 0433), by their model name. */
export const CITATION_STYLES = [
  'authorYear',
  'numeric',
  'alphabetic',
  'authorTitle',
  'numericComp',
] as const;
export type CitationStyle = (typeof CITATION_STYLES)[number];

interface StyleRow {
  /** The biblatex style and the sorting that goes with it. */
  style: Tex;
  sorting: Tex;
  /** What the label of a bibliography entry is: the number, the alphabetic label, or none. */
  label: 'number' | 'alpha' | 'none';
}

const STYLE_TABLE: Readonly<Record<CitationStyle, StyleRow>> = {
  authorYear: { style: lit('authoryear'), sorting: lit('nyt'), label: 'none' },
  numeric: { style: lit('numeric'), sorting: lit('none'), label: 'number' },
  alphabetic: { style: lit('alphabetic'), sorting: lit('anyt'), label: 'alpha' },
  authorTitle: { style: lit('authortitle'), sorting: lit('nyt'), label: 'none' },
  numericComp: { style: lit('numeric-comp'), sorting: lit('none'), label: 'number' },
};

export function styleRow(style: string | null | undefined): StyleRow {
  return style && Object.hasOwn(STYLE_TABLE, style)
    ? STYLE_TABLE[style as CitationStyle]
    : STYLE_TABLE.authorYear;
}

/** True when `style` is one of the styles a job can ask for. */
export const isCitationStyle = (style: unknown): style is CitationStyle =>
  typeof style === 'string' && Object.hasOwn(STYLE_TABLE, style);

interface KindRow {
  type: Tex;
  /** The field the container title goes in. */
  container: Tex;
  /** The field the publisher goes in. */
  publisher: Tex;
}

const row = (type: Tex, container: Tex, publisher: Tex): KindRow => ({
  type,
  container,
  publisher,
});
const PUBLISHER = lit('publisher');
const INSTITUTION = lit('institution');
const TITLEADDON = lit('titleaddon');

const KINDS: Readonly<Record<string, KindRow>> = {
  article: row(lit('article'), lit('journaltitle'), PUBLISHER),
  'article-journal': row(lit('article'), lit('journaltitle'), PUBLISHER),
  'article-magazine': row(lit('article'), lit('journaltitle'), PUBLISHER),
  'article-newspaper': row(lit('article'), lit('journaltitle'), PUBLISHER),
  review: row(lit('article'), lit('journaltitle'), PUBLISHER),
  'review-book': row(lit('article'), lit('journaltitle'), PUBLISHER),
  book: row(lit('book'), lit('maintitle'), PUBLISHER),
  classic: row(lit('book'), lit('maintitle'), PUBLISHER),
  collection: row(lit('collection'), lit('maintitle'), PUBLISHER),
  periodical: row(lit('periodical'), lit('maintitle'), PUBLISHER),
  chapter: row(lit('incollection'), lit('booktitle'), PUBLISHER),
  'entry-dictionary': row(lit('inreference'), lit('booktitle'), PUBLISHER),
  'entry-encyclopedia': row(lit('inreference'), lit('booktitle'), PUBLISHER),
  entry: row(lit('inreference'), lit('booktitle'), PUBLISHER),
  'paper-conference': row(lit('inproceedings'), lit('booktitle'), PUBLISHER),
  report: row(lit('report'), TITLEADDON, INSTITUTION),
  thesis: row(lit('thesis'), TITLEADDON, INSTITUTION),
  patent: row(lit('patent'), TITLEADDON, INSTITUTION),
  standard: row(lit('standard'), TITLEADDON, lit('organization')),
  webpage: row(lit('online'), TITLEADDON, lit('organization')),
  post: row(lit('online'), TITLEADDON, lit('organization')),
  'post-weblog': row(lit('online'), TITLEADDON, lit('organization')),
  dataset: row(lit('dataset'), TITLEADDON, PUBLISHER),
  software: row(lit('software'), TITLEADDON, PUBLISHER),
  manuscript: row(lit('unpublished'), TITLEADDON, PUBLISHER),
};
const MISC = row(lit('misc'), TITLEADDON, PUBLISHER);

interface Person {
  family?: string;
  given?: string;
  particle?: string;
  suffix?: string;
  literal?: string;
}

const people = (v: unknown): Person[] =>
  Array.isArray(v) ? (v.filter((p) => p && typeof p === 'object') as Person[]) : [];

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** One name in biber's key-value form; a literal name (an organisation) is one protected word. */
function name(p: Person): Tex | null {
  const literal = s(p.literal);
  if (literal) return tex`{${bibField(literal)}}`;
  const family = s(p.family) ?? s(p.given);
  if (!family) return null;
  const given = s(p.family) ? s(p.given) : null;
  const parts: Tex[] = [tex`family={${bibField(family)}}`];
  if (given) parts.push(tex`given={${bibField(given)}}`);
  if (s(p.particle)) parts.push(tex`prefix={${bibField(p.particle!)}}`);
  if (s(p.suffix)) parts.push(tex`suffix={${bibField(p.suffix!)}}`);
  return join(parts, lit(', '));
}

const names = (list: Person[]): Tex | null => {
  const out = list.map(name).filter((n): n is Tex => n !== null);
  return out.length ? join(out, lit(' and ')) : null;
};

export interface BibFile {
  /** The text of `references.bib`. */
  text: string;
  /** The entry key of each source, by source identifier. */
  keys: ReadonlyMap<string, Tex>;
}

/** `references.bib`: every source of the document, in document order. */
export function bibFile(sources: ReadonlyMap<string, J>): BibFile {
  const keys = new Map<string, Tex>();
  const used = new Set<string>();
  const entries: Tex[] = [
    lit('% references.bib: generated by @docedit/export-latex from the sources of the document.'),
  ];
  let counter = 1;
  for (const [id, src] of sources) {
    const key = bibKey(id, counter++, used);
    used.add(key);
    keys.set(id, key);
    const a = src.attrs ?? {};
    const kind = KINDS[s(a['kind']) ?? 'book'] ?? MISC;
    const fields: Tex[] = [];
    const field = (name: Tex, value: Tex | null): void => {
      if (value !== null) fields.push(tex`  ${name} = {${value}},`);
    };
    const str = (k: string): Tex | null => (s(a[k]) ? bibField(s(a[k])!) : null);
    const authors = names(people(a['authors']));
    const editors = names(people(a['editors']));
    field(lit('author'), authors);
    field(lit('editor'), editors);
    field(lit('title'), str('title'));
    field(kind.container, str('containerTitle'));
    field(lit('date'), str('issued'));
    field(lit('urldate'), str('accessed'));
    field(kind.publisher, str('publisher'));
    field(lit('location'), str('publisherPlace'));
    field(lit('edition'), str('edition'));
    field(lit('volume'), str('volume'));
    // The issue of an article is its `number`; a report or standard has its own number.
    field(lit('number'), str('issue') ?? str('number'));
    field(lit('pages'), str('pages'));
    field(lit('doi'), s(a['doi']) ? bibVerbatim(s(a['doi'])!) : null);
    field(lit('url'), s(a['url']) ? bibVerbatim(s(a['url'])!) : null);
    field(lit('isbn'), str('isbn'));
    field(lit('issn'), str('issn'));
    field(lit('note'), str('note'));
    entries.push(join([tex`@${kind.type}{${key},`, ...fields, lit('}')], lit('\n')));
  }
  return { text: join(entries, lit('\n\n')) + '\n', keys };
}

/** The biblatex package line and the resource line of the preamble. */
export function biblatexPreamble(style: string | null | undefined): Tex[] {
  const row = styleRow(style);
  return [
    tex`\usepackage[backend=biber,style=${row.style},sorting=${row.sorting}]{biblatex}`,
    lit('\\addbibresource{references.bib}'),
  ];
}

interface Item {
  source?: unknown;
  prefix?: unknown;
  suffix?: unknown;
  locator?: unknown;
  label?: unknown;
}

/**
 * A citation as one biblatex command, or null when none of its sources is in the `.bib` file.
 * `normal` is `\parencite`, `narrative` is `\textcite`, and `suppressAuthor` is the starred
 * `\parencite*` (which prints the year only in an author-year style). Several sources use the
 * multicite form (`\parencites`, `\textcites`). A prefix is the pre-note and a locator with its
 * label and the suffix are the post-note. Every note goes through `text`.
 */
export function citeTex(node: J, keys: ReadonlyMap<string, Tex>): Tex | null {
  const items = ((node.attrs?.['items'] as Item[] | undefined) ?? []).filter(
    (i): i is Item => typeof i === 'object' && i !== null,
  );
  const resolved = items.filter((i) => typeof i.source === 'string' && keys.has(i.source));
  if (resolved.length === 0) return null;
  const mode = s(node.attrs?.['mode']) ?? 'normal';
  const notes = (item: Item): { pre: Tex | null; post: Tex | null } => {
    const pre = s(item.prefix);
    const loc = locatorText({
      ...(typeof item.locator === 'string' ? { locator: item.locator } : {}),
      ...(typeof item.label === 'string' ? { label: item.label } : {}),
      source: '',
    });
    const suffix = s(item.suffix);
    const post = [loc, suffix].filter((x) => x).join(' ');
    return { pre: pre ? text(pre) : null, post: post ? text(post) : null };
  };
  const optional = (pre: Tex | null, post: Tex | null): Tex =>
    pre === null && post === null
      ? EMPTY
      : post === null
        ? tex`[${pre ?? EMPTY}][]`
        : pre === null
          ? tex`[][${post}]`
          : tex`[${pre}][${post}]`;
  const key = (item: Item): Tex => tex`{${keys.get(item.source as string)!}}`;
  if (resolved.length === 1) {
    const item = resolved[0]!;
    const n = notes(item);
    const cmd = mode === 'narrative' ? lit('\\textcite') : lit('\\parencite');
    const star = mode === 'suppressAuthor' ? lit('*') : EMPTY;
    return tex`${cmd}${star}${optional(n.pre, n.post)}${key(item)}`;
  }
  const cmd = mode === 'narrative' ? lit('\\textcites') : lit('\\parencites');
  const star = mode === 'suppressAuthor' ? lit('*') : EMPTY;
  return tex`${cmd}${star}${join(
    resolved.map((item) => {
      const n = notes(item);
      return tex`${optional(n.pre, n.post)}${key(item)}`;
    }),
  )}`;
}

/** `\nocite{*}` before the bibliography of `include: all`. */
export const NOCITE_ALL: Tex = lit('\\nocite{*}');
