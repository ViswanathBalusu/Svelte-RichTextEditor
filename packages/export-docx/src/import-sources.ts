/**
 * Reads Word's bibliography sources part (a custom XML item whose root is `b:Sources`) into source
 * definitions (EXP-122, criterion 2). A source is read only as far as writing it back from the
 * model gives the same elements: what the model has no place for (`b:RefOrder`, `b:Month`,
 * a person's middle name, a source type the writer would change) stays in the source's `preserved`
 * tree and is written back with it (criterion 3). The root's attributes (`SelectedStyle`,
 * `StyleName`, `Version`) are kept as they are, because the part is rebuilt around the original
 * bytes of the root's start and end (see `Writer.sourcesPart` in export.ts).
 */
import { nodeId, type JsonNode } from '@docedit/model';
import type { JsonValue } from '@docedit/model/definition';
import {
  BIBLIOGRAPHY_NS,
  containerElement,
  kindOfSourceType,
  sourceType,
} from './writer-citations.ts';
import { NotRepresentable, type TreeBody, type TreeNode, checkPreserved, toTree } from './tree.ts';
import { type XmlElement, elements, textContent } from './xml.ts';

export interface ImportedSource {
  node: JsonNode;
  /** The tag Word cites the source by. */
  tag: string;
  /** Byte range of the `b:Source` element in the part. */
  start: number;
  end: number;
}

export interface ImportedSources {
  sources: ImportedSource[];
  /** End of the bytes before the first source, and start of the bytes after the last. */
  prefixEnd: number;
  suffixStart: number;
  /** Sources left out, with the reason. */
  skipped: string[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The model's `source_def.url` pattern (`SOURCE_URL_PATTERN` in packages/model, not exported from it). */
const URL_PATTERN = /^https?:\/\/[^\s<>"{}|\\^`]+$/;
// eslint-disable-next-line no-control-regex -- controls are the thing refused
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

const inBib = (e: XmlElement, local: string): boolean =>
  e.ns === BIBLIOGRAPHY_NS && e.local === local;

/** The sources of a `b:Sources` root, or null when the root is not one or holds no source. */
export function importSources(root: XmlElement, keepResidue: boolean): ImportedSources | null {
  if (!inBib(root, 'Sources')) return null;
  const kids = elements(root);
  const found = kids.filter((k) => inBib(k, 'Source'));
  const first = found[0];
  const last = found[found.length - 1];
  if (!first || !last || found.length !== kids.length) return null;
  const out: ImportedSources = {
    sources: [],
    prefixEnd: first.start,
    suffixStart: last.end,
    skipped: [],
  };
  const seen = new Set<string>();
  for (const src of found) {
    const read = readSource(src, keepResidue);
    if (!read) {
      out.skipped.push('a source with no tag Word can cite, or content that cannot be kept');
      continue;
    }
    if (seen.has(read.tag)) {
      out.skipped.push(`a second source with the tag ${read.tag}`);
      continue;
    }
    seen.add(read.tag);
    out.sources.push({ node: read.node, tag: read.tag, start: src.start, end: src.end });
  }
  return out;
}

/**
 * The identifier of a source is a fresh one, as for every node of an import (nothing is taken from
 * the file); the tag Word cites it by is kept in the source map (`DefSource.wordId`).
 */
function readSource(src: XmlElement, keepResidue: boolean): { node: JsonNode; tag: string } | null {
  const kids = elements(src);
  const used = new Set<XmlElement>();
  const only = (local: string): XmlElement | undefined => {
    const hit = kids.filter((k) => inBib(k, local));
    return hit.length === 1 ? hit[0] : undefined;
  };
  const leaf = (local: string, max: number, pattern?: RegExp): string | null => {
    const e = only(local);
    if (!e || elements(e).length) return null;
    const v = textContent(e);
    if (!v || v.length > max || CONTROL.test(v) || (pattern && !pattern.test(v))) return null;
    used.add(e);
    return v;
  };

  const tag = leaf('Tag', 64, ID);
  if (tag === null) return null;
  const attrs: Record<string, JsonValue> = { id: nodeId() };

  const typeText = leaf('SourceType', 64);
  const kind = typeText === null ? null : kindOfSourceType(typeText);
  if (kind !== null) attrs['kind'] = kind;
  else if (typeText !== null) {
    // The writer would change the type: the element stays as it is, and the kind is the generic one.
    used.delete(only('SourceType')!);
    attrs['kind'] = 'document';
  } else attrs['kind'] = 'book';

  const contributors = only('Author');
  if (contributors) {
    const people = readContributors(contributors);
    if (people) {
      used.add(contributors);
      if (people.authors) attrs['authors'] = people.authors;
      if (people.editors) attrs['editors'] = people.editors;
    }
  }

  const set = (key: string, value: string | null): void => {
    if (value !== null) attrs[key] = value;
  };
  set('title', leaf('Title', 1024));
  set('issued', leaf('Year', 4, /^[0-9]{4}$/));
  if (kind !== null) set('containerTitle', leaf(containerElement(sourceType(kind)), 1024));
  set('publisher', leaf('Publisher', 255));
  set('publisherPlace', leaf('City', 255));
  set('edition', leaf('Edition', 64));
  set('volume', leaf('Volume', 64));
  set('issue', leaf('Issue', 64));
  set('pages', leaf('Pages', 64));
  set('url', leaf('URL', 2048, URL_PATTERN));
  set('note', leaf('Comments', 2048));

  const rest = kids.filter((k) => !used.has(k));
  if (rest.length) {
    if (!keepResidue) return { node: { type: 'source_def', attrs }, tag };
    const children: TreeNode[] = [];
    try {
      for (const r of rest) children.push(toTree(r));
    } catch (e) {
      if (e instanceof NotRepresentable) return null;
      throw e;
    }
    const body: TreeBody = { children };
    if (checkPreserved(body).length) return null;
    attrs['preserved'] = body as unknown as JsonValue;
  }
  return { node: { type: 'source_def', attrs }, tag };
}

interface Contributors {
  authors: Array<Record<string, string>> | null;
  editors: Array<Record<string, string>> | null;
}

/** The authors and editors of a `b:Author`, when it has only the shapes the model writes back. */
function readContributors(outer: XmlElement): Contributors | null {
  const out: Contributors = { authors: null, editors: null };
  const parts = elements(outer);
  if (!parts.length) return null;
  for (const p of parts) {
    const which = inBib(p, 'Author') ? 'authors' : inBib(p, 'Editor') ? 'editors' : null;
    if (which === null || out[which] !== null) return null;
    const list = readNames(p);
    if (!list) return null;
    out[which] = list;
  }
  return out;
}

function readNames(holder: XmlElement): Array<Record<string, string>> | null {
  const inner = elements(holder);
  if (inner.length !== 1) return null;
  const [one] = inner;
  if (!one) return null;
  const text = (e: XmlElement): string | null => {
    if (elements(e).length) return null;
    const v = textContent(e);
    return v.length <= 255 && !CONTROL.test(v) ? v : null;
  };
  if (inBib(one, 'Corporate')) {
    const v = text(one);
    return v ? [{ literal: v }] : null;
  }
  if (!inBib(one, 'NameList')) return null;
  const persons = elements(one);
  if (!persons.length || persons.length > 100) return null;
  const people: Array<Record<string, string>> = [];
  for (const person of persons) {
    if (!inBib(person, 'Person')) return null;
    const parts = elements(person);
    const entry: Record<string, string> = {};
    for (const part of parts) {
      const key = inBib(part, 'Last') ? 'family' : inBib(part, 'First') ? 'given' : null;
      if (key === null || key in entry) return null;
      const v = text(part);
      if (v === null) return null;
      if (v) entry[key] = v;
    }
    // The writer gives a person with no name at all two empty elements, so one must have a value.
    if (!Object.keys(entry).length) return null;
    people.push(entry);
  }
  return people;
}
