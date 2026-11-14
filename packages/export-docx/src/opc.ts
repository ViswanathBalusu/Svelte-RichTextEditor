/**
 * Open Packaging Conventions (ECMA-376 Part 2): part names, content types and relationships.
 */
import { NS } from './ooxml.ts';
import { type XmlElement, attr, elements, parseXml } from './xml.ts';

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
  /** Byte range of the Relationship element in its part, for patching. */
  start: number;
  end: number;
}

export interface Relationships {
  /** The part these relationships belong to ('' for the package). */
  source: string;
  byId: Map<string, Relationship>;
  list: Relationship[];
  /** Offset of `</Relationships>`, where new relationships go. */
  insertAt: number;
}

export function relsPartName(part: string): string {
  if (!part) return '_rels/.rels';
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** Resolves a relationship target against its source part; returns a part name without a leading slash. */
export function resolveTarget(source: string, target: string): string {
  if (target.startsWith('/')) return normalise(target.slice(1));
  const base = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : '';
  return normalise(base + target);
}

function normalise(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(decodeURIComponentSafe(seg));
  }
  return out.join('/');
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseRelationships(source: string, bytes: Uint8Array | undefined): Relationships {
  const rels: Relationships = { source, byId: new Map(), list: [], insertAt: -1 };
  if (!bytes) return rels;
  const doc = parseXml(bytes);
  for (const el of elements(doc.root)) {
    if (el.ns !== NS.pr || el.local !== 'Relationship') continue;
    const r: Relationship = {
      id: attr(el, '', 'Id') ?? '',
      type: attr(el, '', 'Type') ?? '',
      target: attr(el, '', 'Target') ?? '',
      external: (attr(el, '', 'TargetMode') ?? '') === 'External',
      start: el.start,
      end: el.end,
    };
    rels.list.push(r);
    rels.byId.set(r.id, r);
  }
  rels.insertAt = doc.root.endTagStart;
  return rels;
}

export interface ContentTypes {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
  overrideRanges: Map<string, [number, number]>;
}

export function parseContentTypes(bytes: Uint8Array): ContentTypes {
  const doc = parseXml(bytes);
  const ct: ContentTypes = { defaults: new Map(), overrides: new Map(), overrideRanges: new Map() };
  for (const el of elements(doc.root)) {
    if (el.ns !== NS.ct) continue;
    if (el.local === 'Default')
      ct.defaults.set(
        (attr(el, '', 'Extension') ?? '').toLowerCase(),
        attr(el, '', 'ContentType') ?? '',
      );
    else if (el.local === 'Override') {
      const name = (attr(el, '', 'PartName') ?? '').replace(/^\//, '');
      ct.overrides.set(name.toLowerCase(), attr(el, '', 'ContentType') ?? '');
      ct.overrideRanges.set(name.toLowerCase(), [el.start, el.end]);
    }
  }
  return ct;
}

export function contentTypeOf(ct: ContentTypes, part: string): string | undefined {
  const o = ct.overrides.get(part.toLowerCase());
  if (o) return o;
  const dot = part.lastIndexOf('.');
  return dot < 0 ? undefined : ct.defaults.get(part.slice(dot + 1).toLowerCase());
}

/** Relationship ids an element and its descendants refer to (any attribute in the r namespace). */
export function referencedRelIds(el: XmlElement, out: Set<string> = new Set()): Set<string> {
  const stack = [el];
  while (stack.length) {
    const e = stack.pop()!;
    for (const a of e.attrs) if (a.ns === NS.r) out.add(a.value);
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c.kind === 'element') stack.push(c);
    }
  }
  return out;
}
