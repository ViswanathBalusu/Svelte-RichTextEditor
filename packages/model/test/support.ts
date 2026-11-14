/**
 * Helpers shared by the model's tests: copies of the fixtures, node builders, and shortcuts that
 * return the invariants and codes `validate()` reports. Node.js only (tsconfig.node.json).
 */
import example from '../fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '../fixtures/kitchen-sink.json' with { type: 'json' };
import { validate, type ValidationContext } from '../src/validate/index.ts';

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ASSET = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
export const ASSET_2 = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11';
export const SINK_ASSETS = new Set([
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a12',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a13',
]);

/** A context that lets every context-dependent invariant run. */
export const ctx: ValidationContext = {
  attachedAssets: new Set([ASSET, ASSET_2]),
  retiredRegionIds: new Set(['rRetiredRegion01']),
  mathGate: () => null,
  identifierChanges: [],
};
export const sinkCtx: ValidationContext = { ...ctx, attachedAssets: SINK_ASSETS };

/** A fresh copy of the 03 §12 example. */
export const exampleDoc = (): Json => structuredClone(example) as Json;
/** A fresh copy of the kitchen-sink fixture. */
export const sinkDoc = (): Json => structuredClone(kitchenSink) as Json;

export const defsOf = (doc: Json): Json[] => doc['doc'].content[0].content;
/** The body's children. */
export const bodyOf = (doc: Json): Json[] =>
  doc['doc'].content.find((n: Json) => n.type === 'body').content;

/** Inserts definition nodes before the first node of a later kind, keeping the order of 03 §4.1. */
export function addDefs(doc: Json, ...nodes: Json[]): Json {
  const order = [
    'settings',
    'style_def',
    'numbering_def',
    'page_setup',
    'role_def',
    'rule_def',
    'source_def',
    'preserved_def',
  ];
  const list = defsOf(doc);
  for (const n of nodes) {
    const rank = order.indexOf(n['type']);
    const at = list.findIndex((x) => order.indexOf(x['type']) > rank);
    list.splice(at < 0 ? list.length : at, 0, n);
  }
  return doc;
}

let counter = 0;
/** A fresh 16-character node identifier with a readable prefix. */
export function nid(prefix = 'n'): string {
  counter++;
  return `${prefix}${String(counter).padStart(16 - prefix.length, '0')}`.slice(0, 16);
}

export const text = (t: string, marks?: Json[]): Json =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
export const para = (id: string, content: Json[] | string = 'x', attrs: Json = {}): Json => ({
  type: 'paragraph',
  attrs: { id, ...attrs },
  content: typeof content === 'string' ? [text(content)] : content,
});
export const cell = (id: string, content: Json[] = [para(nid('p'))], attrs: Json = {}): Json => ({
  type: 'table_cell',
  attrs: { id, ...attrs },
  content,
});
export const row = (id: string, cells: Json[], attrs: Json = {}): Json => ({
  type: 'table_row',
  attrs: { id, ...attrs },
  content: cells,
});
export const table = (id: string, grid: number[], rows: Json[], attrs: Json = {}): Json => ({
  type: 'table',
  attrs: { id, grid, ...attrs },
  content: rows,
});
export const footnote = (id: string, content: Json[] = [para(nid('p'), 'note')]): Json => ({
  type: 'footnote',
  attrs: { id },
  content,
});
export const style = (id: string, attrs: Json = {}): Json => ({
  type: 'style_def',
  attrs: { id, name: id, ...attrs },
});

export function report(doc: unknown, c: ValidationContext = ctx) {
  return validate(doc, c);
}
/** The distinct invariants `validate()` reports, in path order. */
export function invariants(doc: unknown, c: ValidationContext = ctx): string[] {
  return [...new Set(validate(doc, c).violations.map((v) => v.invariant))];
}
/** The distinct codes `validate()` reports. */
export function codes(doc: unknown, c: ValidationContext = ctx): string[] {
  return [...new Set(validate(doc, c).violations.map((v) => v.code))];
}
