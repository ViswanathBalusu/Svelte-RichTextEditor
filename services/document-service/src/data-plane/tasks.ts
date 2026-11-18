/**
 * The heavy work of the data plane, as pure functions over plain data (06 §1, §2.2; SYN-039): a
 * worker thread runs them (worker.ts), so that a checkpoint of a large document or a replay for a
 * content read never holds the event loop that acknowledges commits. They receive all their input
 * as plain data (JSON values and byte arrays) and need none of the room's state (SYN-039
 * criterion 3). Errors are reported by name only: a message could quote content (BE-088).
 */
import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { DEFAULT_LIMITS, applySteps, parseSteps, type StepJson } from '@docedit/authority';
import { canonicalText, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { tokenCounts } from '../control-plane/search-index.ts';

/** Where a replay starts: a stored checkpoint's bytes, or a document as JSON. */
export type Base = { readonly encoded: Uint8Array } | { readonly doc: unknown };

export interface ReplayInput {
  readonly base: Base;
  readonly cdm: number;
  readonly requires: readonly string[];
  /** The steps of each commit after the base, in order; empty for control commits. */
  readonly commits: ReadonlyArray<readonly StepJson[]>;
}

export interface Encoded {
  /** The canonical JSON text of the envelope (03 §2), compressed with Zstandard. */
  readonly encoded: Uint8Array;
  /** SHA-256 of that text, lower-case hex: `documentHash` of the model (04 §13). */
  readonly hash: string;
  /** Bytes of the canonical text before compression (I7). */
  readonly bytes: number;
}

/**
 * A checkpoint as plain data for a room to open from (BE-019 criterion 5; owner decision 72, ADR
 * 0333): parsed and validated in a worker, then handed over as text that the main thread reads a
 * slice at a time, so that it never holds the event loop for the whole document.
 */
export interface OpenedParts {
  readonly cdm: number;
  readonly requires: readonly string[];
  /** The canonical size of `doc` before the children of the large containers were taken out. */
  readonly bytes: number;
  /** The document with the children of each large container of the root taken out. */
  readonly doc: JsonNode;
  /** For each such container: its index in the root and its children as UTF-8 JSON arrays. */
  readonly split: ReadonlyArray<{ readonly at: number; readonly slices: readonly Uint8Array[] }>;
}

export interface TaskTypes {
  encode: { input: { envelope: JsonEnvelope }; output: Encoded };
  checkpoint: { input: ReplayInput; output: Encoded };
  materialise: { input: ReplayInput; output: { doc: JsonNode } };
  decode: { input: { encoded: Uint8Array }; output: { envelope: JsonEnvelope } };
  /** Decodes, parses and checks a stored checkpoint; `slice` is the children per piece. */
  open: { input: { encoded: Uint8Array; slice: number }; output: OpenedParts };
  /**
   * The words of a checkpoint's text and how often each occurs (BE-054 criterion 5): the indexer
   * job counts here, in a worker thread, so that no room's event loop does it.
   */
  searchTokens: {
    input: { doc: JsonNode };
    output: { tokens: Array<[string, number]>; threadId: number };
  };
  /** For tests: the thread a task runs in. */
  thread: { input: null; output: { threadId: number } };
}

export type TaskName = keyof TaskTypes;

let schemaCache: ReturnType<typeof cdmSchema> | undefined;
const schema = () => (schemaCache ??= cdmSchema());

function baseDoc(base: Base): unknown {
  if ('encoded' in base) return (decode({ encoded: base.encoded }).envelope as JsonEnvelope).doc;
  return base.doc;
}

function replay(input: ReplayInput): JsonNode {
  let doc = schema().nodeFromJSON(baseDoc(input.base));
  for (const steps of input.commits) {
    if (steps.length === 0) continue;
    const parsed = parseSteps(schema(), steps, DEFAULT_LIMITS);
    if (!parsed.ok) throw new Error('a stored commit has steps that do not parse');
    const applied = applySteps(doc, parsed.value);
    if (!applied.ok) throw new Error('a stored commit does not apply');
    doc = applied.value.doc;
  }
  return doc.toJSON() as JsonNode;
}

export function encode(input: { envelope: JsonEnvelope }): Encoded {
  const text = canonicalText(input.envelope);
  const bytes = Buffer.from(text, 'utf8');
  return {
    encoded: new Uint8Array(zstdCompressSync(bytes)),
    hash: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

export function decode(input: { encoded: Uint8Array }): { envelope: JsonEnvelope } {
  return {
    envelope: JSON.parse(zstdDecompressSync(input.encoded).toString('utf8')) as JsonEnvelope,
  };
}

/**
 * Parses the checkpoint as the room would (`nodeFromJSON`, then `check`, which throws on a document
 * that breaks the schema), and cuts the root's large containers into slices of `slice` children.
 */
export function open(input: { encoded: Uint8Array; slice: number }): OpenedParts {
  const env = decode({ encoded: input.encoded }).envelope as JsonEnvelope;
  schema().nodeFromJSON(env.doc).check();
  const root = env.doc as unknown as { content?: JsonNode[] };
  const bytes = Buffer.byteLength(JSON.stringify(root), 'utf8');
  const split: Array<{ at: number; slices: Uint8Array[] }> = [];
  const content = root.content ?? [];
  const kept = content.map((child, at) => {
    const kids = (child as { content?: unknown[] }).content;
    if (!kids || kids.length <= input.slice) return child;
    const slices: Uint8Array[] = [];
    for (let i = 0; i < kids.length; i += input.slice)
      slices.push(new Uint8Array(Buffer.from(JSON.stringify(kids.slice(i, i + input.slice)))));
    split.push({ at, slices });
    return { ...child, content: [] } as JsonNode;
  });
  return {
    cdm: env.cdm,
    requires: [...env.requires],
    bytes,
    doc: { ...(root as object), content: kept } as unknown as JsonNode,
    split,
  };
}

export function checkpoint(input: ReplayInput): Encoded {
  return encode({
    envelope: {
      cdm: input.cdm,
      requires: [...input.requires],
      doc: replay(input),
    } as unknown as JsonEnvelope,
  });
}

export function materialise(input: ReplayInput): { doc: JsonNode } {
  return { doc: replay(input) };
}

/** Runs one task by name: what a worker thread does with a message, and the inline mode. */
export function runTask<K extends TaskName>(
  kind: K,
  input: TaskTypes[K]['input'],
  threadId: number,
): TaskTypes[K]['output'] {
  switch (kind) {
    case 'encode':
      return encode(input as TaskTypes['encode']['input']) as TaskTypes[K]['output'];
    case 'checkpoint':
      return checkpoint(input as ReplayInput) as TaskTypes[K]['output'];
    case 'materialise':
      return materialise(input as ReplayInput) as TaskTypes[K]['output'];
    case 'decode':
      return decode(input as TaskTypes['decode']['input']) as TaskTypes[K]['output'];
    case 'open':
      return open(input as TaskTypes['open']['input']) as TaskTypes[K]['output'];
    case 'searchTokens':
      return {
        tokens: [...tokenCounts((input as TaskTypes['searchTokens']['input']).doc)],
        threadId,
      } as TaskTypes[K]['output'];
    case 'thread':
      return { threadId } as TaskTypes[K]['output'];
    default:
      throw new Error('unknown task');
  }
}
