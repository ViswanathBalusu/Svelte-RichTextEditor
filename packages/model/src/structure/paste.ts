/**
 * Pasted definitions (03 §4.1; CDM-023): when pasted content brings a definition whose identifier
 * already exists in the target document, the pasted nodes refer to the existing definition and no
 * duplicate is inserted; the target's definition wins, built-in styles included. The editing core
 * calls this at paste (FE-050, FE-051) and inserts what it returns.
 *
 * Two rules here are a proposal (docs/adr/0031-cdm-1-model-completion.md), because 03 is silent:
 * a brought definition with a new identifier is added, and a reference that resolves neither in
 * the target nor among the added definitions is dropped (a style becomes null, which means the
 * default style; a character style mark or a cited source is removed).
 */
import type { JsonMark, JsonNode } from '../canonical/canonical-form.ts';
import type { JsonValue } from '../definition/grammar.ts';

/** Definition node types that a paste can bring. */
const DEFINITION_TYPES = new Set(['style_def', 'numbering_def', 'source_def', 'role_def']);

export interface PasteInput {
  /** The definitions that came with the pasted content (from the embedded CDM fragment). */
  definitions: readonly JsonNode[];
  /** The pasted blocks or inline nodes. */
  content: readonly JsonNode[];
}

export interface PasteResult {
  /** Brought definitions with new identifiers, to insert into `defs`, references checked. */
  definitions: JsonNode[];
  /** The content to insert, its references mapped. */
  content: JsonNode[];
  /** Identifiers of brought definitions dropped because the target has them. */
  mapped: string[];
  /** References dropped because they resolve nowhere, as `type:id`. */
  dropped: string[];
}

export interface PasteOptions {
  /** Gives every node of the pasted content a fresh identifier (03 §9: copies get fresh ones). */
  newId?: () => string;
}

interface Known {
  styles: Map<string, string>;
  numberings: Set<string>;
  sources: Set<string>;
  roles: Set<string>;
}

function known(defs: readonly JsonNode[]): Known {
  const k: Known = {
    styles: new Map(),
    numberings: new Set(),
    sources: new Set(),
    roles: new Set(),
  };
  for (const d of defs) {
    const id = d.attrs?.['id'];
    if (typeof id !== 'string') continue;
    if (d.type === 'style_def') k.styles.set(id, String(d.attrs?.['kind'] ?? 'paragraph'));
    else if (d.type === 'numbering_def') k.numberings.add(id);
    else if (d.type === 'source_def') k.sources.add(id);
    else if (d.type === 'role_def') k.roles.add(id);
  }
  return k;
}

const isObject = (v: unknown): v is Record<string, JsonValue> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The definitions of a document (`doc` or `defs` node). */
function definitionsOf(target: JsonNode): JsonNode[] {
  const defs = target.type === 'defs' ? target : target.content?.find((c) => c.type === 'defs');
  return (defs?.content ?? []).filter((d) => DEFINITION_TYPES.has(d.type));
}

/** Maps pasted content and its definitions onto a target document (CDM-023). */
export function mapPastedDefinitions(
  target: JsonNode,
  pasted: PasteInput,
  opts: PasteOptions = {},
): PasteResult {
  const have = known(definitionsOf(target));
  const mapped: string[] = [];
  const dropped: string[] = [];
  const added: JsonNode[] = [];
  for (const d of pasted.definitions) {
    if (!DEFINITION_TYPES.has(d.type)) continue;
    const id = d.attrs?.['id'];
    if (typeof id !== 'string') continue;
    const exists =
      (d.type === 'style_def' && have.styles.has(id)) ||
      (d.type === 'numbering_def' && have.numberings.has(id)) ||
      (d.type === 'source_def' && have.sources.has(id)) ||
      (d.type === 'role_def' && have.roles.has(id));
    if (exists) mapped.push(id);
    else added.push(JSON.parse(JSON.stringify(d)) as JsonNode);
  }
  const all = known([...definitionsOf(target), ...added]);
  const style = (id: unknown, kind: string): boolean =>
    typeof id === 'string' && all.styles.get(id) === kind;
  const drop = (what: string) => dropped.push(what);

  // References between added definitions must resolve too.
  for (const d of added) {
    const a = d.attrs ?? {};
    if (d.type !== 'style_def') continue;
    const kind = String(a['kind'] ?? 'paragraph');
    if (a['basedOn'] !== null && a['basedOn'] !== undefined && !style(a['basedOn'], kind)) {
      drop(`basedOn:${String(a['basedOn'])}`);
      a['basedOn'] = null;
    }
    if (a['next'] !== null && a['next'] !== undefined && !style(a['next'], 'paragraph')) {
      drop(`next:${String(a['next'])}`);
      a['next'] = null;
    }
    if (isObject(a['numbering']) && !all.numberings.has(String(a['numbering']['numberingId']))) {
      drop(`numbering:${String(a['numbering']['numberingId'])}`);
      a['numbering'] = null;
    }
  }

  const marks = (list: JsonMark[] | undefined): JsonMark[] | undefined => {
    if (!list) return list;
    const kept = list.filter((m) => {
      if (m.type !== 'charStyle' || style(m.attrs?.['style'], 'character')) return true;
      drop(`charStyle:${String(m.attrs?.['style'])}`);
      return false;
    });
    return kept.length ? kept : undefined;
  };

  const map = (node: JsonNode): JsonNode | null => {
    const out: JsonNode = { ...node };
    if (node.attrs) out.attrs = { ...node.attrs };
    const a = out.attrs;
    if (a) {
      if (opts.newId && typeof a['id'] === 'string' && node.type !== 'text') a['id'] = opts.newId();
      if (node.type === 'paragraph') {
        if (a['style'] !== null && a['style'] !== undefined && !style(a['style'], 'paragraph')) {
          drop(`style:${String(a['style'])}`);
          a['style'] = null;
        }
        if (
          isObject(a['numbering']) &&
          !all.numberings.has(String(a['numbering']['numberingId']))
        ) {
          drop(`numbering:${String(a['numbering']['numberingId'])}`);
          a['numbering'] = null;
        }
      }
      if (
        node.type === 'table' &&
        a['style'] !== null &&
        a['style'] !== undefined &&
        !style(a['style'], 'table')
      ) {
        drop(`style:${String(a['style'])}`);
        a['style'] = null;
      }
      if (node.type === 'citation' && Array.isArray(a['items'])) {
        const items = a['items'].filter((it) => {
          const ok =
            isObject(it) && typeof it['source'] === 'string' && all.sources.has(it['source']);
          if (!ok) drop(`source:${isObject(it) ? String(it['source']) : '?'}`);
          return ok;
        });
        if (!items.length) return null;
        a['items'] = items;
      }
      if (
        node.type === 'form_field' &&
        typeof a['assignee'] === 'string' &&
        !all.roles.has(a['assignee'])
      ) {
        drop(`role:${a['assignee']}`);
        a['assignee'] = null;
      }
    }
    const m = marks(node.marks);
    if (m) out.marks = m;
    else delete out.marks;
    if (node.content) {
      const content: JsonNode[] = [];
      for (const c of node.content) {
        const mc = map(c);
        if (mc) content.push(mc);
      }
      out.content = content;
    }
    return out;
  };

  const content: JsonNode[] = [];
  for (const c of pasted.content) {
    const mc = map(c);
    if (mc) content.push(mc);
  }
  return { definitions: added, content, mapped, dropped };
}
