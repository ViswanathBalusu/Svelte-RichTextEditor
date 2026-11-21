/**
 * The CDM canonical form (03 §2; CDM-003, CDM-010). The rules are those of ADR 0018, which the
 * owner accepted (decision 7 of docs/owner-decisions-2026-11-15.md); 03 §2 lists them in this
 * order, and prose-canonical.test.ts compares the two:
 *
 * 1. An attribute whose value equals its schema default is omitted. Defaults inside object-valued
 *    attributes are not stripped: the object is compared and kept as a whole.
 * 2. Empty `attrs`, `content` and `marks` are omitted.
 * 3. Marks are ordered by their position in the schema's mark list, then by the RFC 8785 text of
 *    their canonical attributes. Node marks follow the same rule.
 * 4. Adjacent text nodes with equal marks are merged; empty text nodes are dropped.
 * 5. `requires` is sorted by UTF-16 code units and has no duplicates.
 * 6. Every number is an integer in the interoperable range of RFC 8785 (03 §1 principle 7);
 *    anything else is refused with a CanonicalizationError, never written as a float.
 * 7. The bytes are the RFC 8785 serialisation, encoded as UTF-8.
 *
 * The canonical form of a subtree (a region, for the approval hash of 07 §11) is the same rules
 * applied to the node alone, without the envelope. The rules carry the version
 * CANONICAL_FORM_VERSION, which commits and checkpoints record next to every hash they store.
 *
 * Member names come from the document, so they are written as own properties: a key such as
 * `__proto__` stays data and never changes a prototype (CDM-015).
 */
import { CanonicalizationError, canonicalize } from './jcs.ts';
import { sha256Hex } from './hash.ts';
import { findNonIntegers } from '../conventions/validators.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { indexDefinition, type DefinitionIndex } from '../definition/index.ts';
import type { CdmDefinition, JsonValue } from '../definition/grammar.ts';

export const CANONICAL_FORM_VERSION = 1;

export interface JsonMark {
  type: string;
  attrs?: Record<string, JsonValue>;
}

export interface JsonNode {
  type: string;
  attrs?: Record<string, JsonValue>;
  content?: JsonNode[];
  marks?: JsonMark[];
  text?: string;
}

export interface JsonEnvelope {
  cdm: number;
  requires: string[];
  doc: JsonNode;
}

interface Run {
  ix: DefinitionIndex;
  /** Refuse non-integers (the canonical form); off only for size estimates of invalid documents. */
  strict: boolean;
}

/** Sets an own enumerable property, so that `__proto__` is a key like any other. */
function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__')
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  else obj[key] = value;
}

function stripDefaults(
  attrs: Record<string, JsonValue> | undefined,
  spec: Readonly<Record<string, { default: JsonValue }>> | undefined,
  run: Run,
  path: string,
): Record<string, JsonValue> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, JsonValue> = {};
  let any = false;
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === undefined) continue;
    if (run.strict) {
      const bad = findNonIntegers(value, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      if (bad.length)
        throw new CanonicalizationError(
          `${String(bad[0]!.value)} is not an integer in the interoperable range; decimals are strings (03 §1 principle 7)`,
          bad[0]!.path,
        );
    }
    const a = spec && Object.hasOwn(spec, key) ? spec[key] : undefined;
    if (a && canonicalize(value) === canonicalize(a.default)) continue;
    setOwn(out, key, value);
    any = true;
  }
  return any ? out : undefined;
}

function canonicalMarks(
  marks: JsonMark[] | undefined,
  run: Run,
  path: string,
): JsonMark[] | undefined {
  if (!marks || marks.length === 0) return undefined;
  const { ix } = run;
  const keyed = marks.map((m, i) => {
    const attrs = stripDefaults(m.attrs, ix.marks.get(m.type)?.attrs, run, `${path}/${i}/attrs`);
    const mark: JsonMark = attrs ? { type: m.type, attrs } : { type: m.type };
    return {
      mark,
      rank: ix.markRank.get(m.type) ?? Number.MAX_SAFE_INTEGER,
      text: canonicalize(attrs ?? {}),
    };
  });
  keyed.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.text < b.text ? -1 : a.text > b.text ? 1 : 0) ||
      (a.mark.type < b.mark.type ? -1 : a.mark.type > b.mark.type ? 1 : 0),
  );
  return keyed.map((k) => k.mark);
}

function marksKey(marks: JsonMark[] | undefined): string {
  return marks ? canonicalize(marks) : '[]';
}

function canonicalNodeIx(node: JsonNode, run: Run, path: string): JsonNode {
  const out: JsonNode = { type: node.type };
  if (node.type === 'text') {
    out.text = node.text ?? '';
    const marks = canonicalMarks(node.marks, run, `${path}/marks`);
    if (marks) out.marks = marks;
    return out;
  }
  const attrs = stripDefaults(node.attrs, run.ix.nodes.get(node.type)?.attrs, run, `${path}/attrs`);
  if (attrs) out.attrs = attrs;
  if (node.content && node.content.length) {
    const merged: JsonNode[] = [];
    node.content.forEach((child, i) => {
      const c = canonicalNodeIx(child, run, `${path}/content/${i}`);
      if (c.type === 'text') {
        if (!c.text) return;
        const prev = merged[merged.length - 1];
        if (prev && prev.type === 'text' && marksKey(prev.marks) === marksKey(c.marks)) {
          prev.text = (prev.text ?? '') + c.text;
          return;
        }
      }
      merged.push(c);
    });
    if (merged.length) out.content = merged;
  }
  const marks = canonicalMarks(node.marks, run, `${path}/marks`);
  if (marks) out.marks = marks;
  return out;
}

/** The canonical form of a node and its subtree, as a new JSON value. */
export function canonicalNode(node: JsonNode, def: CdmDefinition = CDM1): JsonNode {
  return canonicalNodeIx(node, { ix: indexDefinition(def), strict: true }, '');
}

export function canonicalEnvelope(env: JsonEnvelope, def: CdmDefinition = CDM1): JsonEnvelope {
  const requires = [...new Set(env.requires)].sort();
  return {
    cdm: env.cdm,
    requires,
    doc: canonicalNodeIx(env.doc, { ix: indexDefinition(def), strict: true }, '/doc'),
  };
}

/**
 * The canonical form without the integer rule, for measuring a document that may be invalid
 * (I7's size limit): a float is then an I11 violation, not a failure to measure.
 */
export function canonicalEnvelopeLenient(
  env: JsonEnvelope,
  def: CdmDefinition = CDM1,
): JsonEnvelope {
  const requires = [...new Set(env.requires)].sort();
  return {
    cdm: env.cdm,
    requires,
    doc: canonicalNodeIx(env.doc, { ix: indexDefinition(def), strict: false }, '/doc'),
  };
}

/** RFC 8785 text of the canonical form of an envelope (03 §2). */
export function canonicalText(env: JsonEnvelope, def: CdmDefinition = CDM1): string {
  return canonicalize(canonicalEnvelope(env, def));
}

/** RFC 8785 text of the canonical form of a subtree (07 §11). */
export function canonicalNodeText(node: JsonNode, def: CdmDefinition = CDM1): string {
  return canonicalize(canonicalNode(node, def));
}

/** SHA-256 of the canonical form of a document (03 §2; 04 §13). */
export function documentHash(env: JsonEnvelope, def: CdmDefinition = CDM1): Promise<string> {
  return sha256Hex(canonicalText(env, def));
}

/** SHA-256 of the canonical form of a subtree, such as a region's content (07 §11). */
export function nodeHash(node: JsonNode, def: CdmDefinition = CDM1): Promise<string> {
  return sha256Hex(canonicalNodeText(node, def));
}
