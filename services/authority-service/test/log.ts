// A small log builder for the authority service's tests: a document, typing commits with their hash
// chain, and the checkpoint references and expected documents that go with them.
import { stepsToJson } from '@docedit/authority';
import { payloadDigest, chainHash, type ChainMetadata } from '@docedit/history';
import { documentHash, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Node } from 'prosemirror-model';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import type { CheckpointRef, WireCommit, WirePayload } from '../src/service.ts';

export const schema = cdmSchema();
export const DOC = 'doc-0001';

const para = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id },
  content: text ? [{ type: 'text', text }] : [],
});

export function baseEnvelope(requires: string[] = []): JsonEnvelope {
  return {
    cdm: 1,
    requires,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            para('pOne000000000001', 'First paragraph.'),
            para('pTwo000000000001', 'Second paragraph.'),
          ],
        },
      ],
    } as JsonNode,
  };
}

export const envelopeOf = (doc: Node, requires: string[] = []): JsonEnvelope => ({
  cdm: 1,
  requires,
  doc: doc.toJSON() as JsonNode,
});

/** The position just inside the paragraph with this identifier. */
export function posInside(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (n.attrs['id'] === id) found = pos + 1;
    return found < 0;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

/** The step that types `text` at the start of a paragraph. */
export function typing(doc: Node, id: string, text: string): ReplaceStep {
  const at = posInside(doc, id);
  return new ReplaceStep(at, at, new Slice(Fragment.from(schema.text(text)), 0, 0));
}

export interface Built {
  doc: string;
  commits: WireCommit[];
  /** `docs[i]` is the document at sequence number `i`; `docs[0]` is the one created. */
  docs: Node[];
  /** The chain head at each sequence number; `heads[0]` is null. */
  heads: Array<string | null>;
  /** The checkpoint reference of the document as created. */
  start: CheckpointRef;
}

export async function wireCommit(
  doc: string,
  seq: number,
  prev: string | null,
  kind: 'steps' | 'control' | 'snapshot',
  payload: WirePayload,
): Promise<WireCommit> {
  const digest = await payloadDigest(payload);
  const meta: ChainMetadata = {
    doc,
    seq,
    kind,
    id: `0192f0c4-7b1e-7000-8000-${seq.toString(16).padStart(12, '0')}`,
    user: 'alice',
    session: 's-alice',
    agent: null,
    time: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    origin: kind === 'snapshot' ? 'restore' : 'input',
    scopes: ['body'],
    base: seq - 1,
    rebased: false,
    revision: 1,
    jti: null,
    cdm: 1,
    engine: 'pm-steps/1',
    size: digest.size,
  };
  return {
    meta,
    payloadHash: digest.hash,
    prevHash: prev,
    hash: await chainHash(prev, meta, digest.hash),
    payload,
  };
}

/** A log of typing commits, one per entry of `texts`, from `envelope` (the document as created). */
export async function buildLog(
  texts: readonly string[],
  options: { doc?: string; envelope?: JsonEnvelope } = {},
): Promise<Built> {
  const doc = options.doc ?? DOC;
  const envelope = options.envelope ?? baseEnvelope();
  let current = schema.nodeFromJSON(envelope.doc);
  const docs: Node[] = [current];
  const heads: Array<string | null> = [null];
  const commits: WireCommit[] = [];
  let prev: string | null = null;
  for (const [i, text] of texts.entries()) {
    const step = typing(current, 'pOne000000000001', text);
    current = step.apply(current).doc!;
    const c = await wireCommit(doc, i + 1, prev, 'steps', {
      steps: stepsToJson([step]),
      retired: [],
      claimed: [],
    });
    commits.push(c);
    prev = c.hash;
    docs.push(current);
    heads.push(c.hash);
  }
  return {
    doc,
    commits,
    docs,
    heads,
    start: {
      seq: 0,
      chainHead: null,
      contentHash: await documentHash(envelope),
      content: envelope,
    },
  };
}

/** The checkpoint reference at `seq` of a built log, carrying its content. */
export async function checkpointAt(built: Built, seq: number): Promise<CheckpointRef> {
  const content = envelopeOf(built.docs[seq]!);
  return { seq, chainHead: built.heads[seq]!, contentHash: await documentHash(content), content };
}

/** The `stateId` of the log up to `seq`, from a checkpoint (0 by default). */
export function stateIdAt(built: Built, seq: number): string {
  return built.heads[seq] ?? built.start.contentHash;
}

/**
 * An `applyCommit` request on a log built here: a user with `role` types `text` at `at`, based on
 * `base`. The time is fixed, so that the same request gives the same commits and the same new
 * `stateId` whenever it is applied (the time is part of the hash chain).
 */
export function applyRequest(
  n: number,
  base: number,
  at: number,
  text: string,
  role: 'editor' | 'viewer' = 'editor',
) {
  return {
    commit: {
      id: `0192f0c4-7b1e-7c3a-9a54-${String(n).padStart(12, '0')}`,
      base,
      steps: [
        { stepType: 'replace', from: at, to: at, slice: { content: [{ type: 'text', text }] } },
      ],
      author: { sub: `u-${role}`, session: `s-${role}`, role },
      time: 1_700_000_100_000 + n * 1000,
    },
    // The revision the commits of `wireCommit` were stored under.
    permissions: { revision: 1, grants: [] },
  };
}

/** An `open` request for the log from a checkpoint to `seq`. */
export async function openRequest(built: Built, seq: number, from = 0) {
  return {
    doc: built.doc,
    checkpointRef: from === 0 ? built.start : await checkpointAt(built, from),
    commits: built.commits.slice(from, seq),
    stateId: from === seq && from > 0 ? built.heads[seq]! : stateIdAt(built, seq),
  };
}
