// Shared helpers for the protocol package's tests: the repository root, the published artifacts and
// Ajv instances that resolve the CDM schema the way implementers would.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema } from 'ajv';

export const root = resolve(import.meta.dirname, '../../..');
export const readText = (path: string): string => readFileSync(resolve(root, path), 'utf8');
export const readJson = <T = Record<string, unknown>>(path: string): T =>
  JSON.parse(readText(path)) as T;

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as (ajv: Ajv | Ajv2020) => unknown;

export const CDM_PATH = 'spec/cdm/cdm-1.schema.json';
export const cdmSchema = (): Record<string, unknown> => readJson(CDM_PATH);

/** Ajv for JSON Schema 2020-12 (OpenAPI 3.1 and the standalone schemas), with formats and the CDM schema. */
export function ajv2020(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    allErrors: true,
    unicodeRegExp: true,
  });
  addFormats(ajv);
  ajv.addSchema(cdmSchema() as AnySchema);
  return ajv;
}

/** Ajv for draft-07 (the AsyncAPI 3.0 schema format), with formats. */
export function ajvDraft7(): Ajv {
  const ajv = new Ajv({ strict: true, strictTypes: false, allErrors: true, unicodeRegExp: true });
  addFormats(ajv);
  return ajv;
}

/** Replaces every string `from` found in a JSON value (used to rebase `$ref`s). */
export function rewriteRefs(value: unknown, from: string, to: string): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .split(JSON.stringify(from).slice(1, -1))
      .join(JSON.stringify(to).slice(1, -1)),
  );
}

/** Every `$ref` in a JSON value. */
export function refsOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) refsOf(v, out);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else refsOf(v, out);
    }
  return out;
}

/** Resolves a JSON Pointer fragment (`#/a/b`) inside a document. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith('#')) throw new Error(`not a local pointer: ${pointer}`);
  const parts = pointer
    .slice(1)
    .split('/')
    .filter((p, i) => i > 0 || p !== '')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = doc;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
