/**
 * `origin` of an inline atom without a preserved fragment of its own (03 §4.6; SR-M10; spike S11,
 * model change 2): the fragment asset holding the original element, and the SHA-256 of the atom's
 * modelled attributes at import. While the hash still matches, the DOCX writer writes the original
 * element back; once it differs, the atom was edited and is written from the model, keeping what
 * it can of the original.
 */
import { jcsHash, type JsonNode } from '@docedit/model';
import { CDM1, indexDefinition, type JsonValue } from '@docedit/model/definition';

const ix = indexDefinition(CDM1);

/** Attributes that are not modelled content: the preservation layer's own, and `ext`. */
const NOT_MODELLED: ReadonlySet<string> = new Set(['origin', 'preserved', 'ext']);

export interface Origin {
  fragment: string;
  hash: string;
}

export function isOrigin(v: unknown): v is Origin {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['fragment'] === 'string' && typeof r['hash'] === 'string';
}

/** The modelled attributes of a node with the definition's defaults filled in. */
export function modelledAttributes(node: JsonNode): Record<string, JsonValue> {
  const def = ix.nodes.get(node.type);
  const out: Record<string, JsonValue> = {};
  for (const [k, a] of Object.entries(def?.attrs ?? {})) {
    if (NOT_MODELLED.has(k)) continue;
    out[k] = (node.attrs?.[k] ?? a.default) as JsonValue;
  }
  return out;
}

/** The `origin.hash` of a node: SHA-256 of its type and modelled attributes (RFC 8785). */
export function modelledHash(node: JsonNode): Promise<string> {
  return jcsHash({ type: node.type, attrs: modelledAttributes(node) });
}
