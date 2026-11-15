/**
 * Shared helpers for the suites that replay the invariant fixtures of CDM-014
 * (`packages/model/fixtures/invariants/cases`) through the real service as commits (SEC-027).
 * A fixture is a base document, the steps of one commit and the invariants its result breaks.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { chunkMessage } from '@docedit/protocol';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Harness } from './harness.ts';
import { WireClient, type Received } from './wire.ts';

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const FIXTURES = fileURLToPath(
  new URL('../../../../packages/model/fixtures/', import.meta.url),
);
export const CASES = FIXTURES + 'invariants/cases/';
export const MAX_FRAME = 131_072; // maxMessageBytes (05 §4; protocol negotiation)

/** One fixture of the corpus, as stored. */
export interface CorpusCase {
  name: string;
  doc: string;
  base: string | Json;
  steps: Json[];
  context: Json;
  expected: string[];
  limit?: { name: string; side: 'at' | 'past' };
}

/** Expands `{ "$repeat": s, "count": n }` into s repeated n times, as the model's loader does. */
export function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const o = value as Json;
    if (typeof o['$repeat'] === 'string' && typeof o['count'] === 'number')
      return (o['$repeat'] as string).repeat(o['count'] as number);
    const out: Json = {};
    for (const [k, v] of Object.entries(o)) out[k] = expand(v);
    return out;
  }
  return value;
}

export function baseOf(base: unknown): Json {
  if (typeof base === 'object' && base !== null) return expand(base) as Json;
  const file = base === 'kitchen-sink' ? 'kitchen-sink.json' : 'example-03-12.json';
  return JSON.parse(readFileSync(FIXTURES + file, 'utf8')) as Json;
}

export function readCase(name: string): Json {
  return JSON.parse(readFileSync(`${CASES}${name}.json`, 'utf8')) as Json;
}

/** Every fixture of the corpus, sorted by name. */
export function allCases(): CorpusCase[] {
  return readdirSync(CASES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(CASES + f, 'utf8')) as CorpusCase)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A fixture without steps describes a stored document that no step may produce. As a commit, its
 * base is the document without the last block of the body, and the commit inserts that block at
 * the end of the body.
 */
export function asCommit(base: Json, steps: Json[]): { base: Json; steps: Json[] } {
  if (steps.length > 0) return { base, steps };
  const shorter = structuredClone(base);
  const body = (shorter['doc']['content'] as Json[]).find((n) => n['type'] === 'body')!;
  const block = (body['content'] as Json[]).pop()!;
  const end = cdmSchema().nodeFromJSON(shorter['doc']).content.size - 1;
  return {
    base: shorter,
    steps: [{ stepType: 'replace', from: end, to: end, slice: { content: [block] } }],
  };
}

/**
 * Submits a commit as the component would: one frame when it fits maxMessageBytes, otherwise
 * chunks. Resolves with the answer (`sync.ack` or `sync.reject`).
 */
export async function submitCommit(
  c: WireClient,
  commit: { id: string; base: number; steps: unknown[] },
): Promise<Received> {
  const id = c.nextId();
  const envelope = { t: 'sync.submit', id, ch: 1, d: commit };
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text, 'utf8') <= MAX_FRAME) c.sendRaw(text);
  else for (const frame of chunkMessage(text, MAX_FRAME, uuid7())) c.sendRaw(frame);
  return c.take((m) => m.re === id, 60_000, `answer to sync.submit ${id}`);
}

/** Connects an owner of `doc` and opens it on channel 1 with the features the document requires. */
export async function openAsOwner(h: Harness, doc: string, requires: unknown): Promise<WireClient> {
  const features = [
    ...new Set(['presence', 'regions', ...(Array.isArray(requires) ? (requires as string[]) : [])]),
  ];
  const token = await h.mintToken(h.a, 'olivia', { [doc]: 'owner' });
  const owner = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
  try {
    const welcome = await owner.hello(token, { features });
    expect(welcome.t, JSON.stringify(welcome.d)).toBe('welcome');
    const opened = await owner.open(1, doc, { features });
    expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');
    return owner;
  } catch (e) {
    owner.terminate();
    throw e;
  }
}

export async function contentOf(h: Harness, doc: string): Promise<Json> {
  return (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json as Json;
}
