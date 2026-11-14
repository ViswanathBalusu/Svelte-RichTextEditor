/**
 * Builds log bundles the way the document service writes its rows (ADR 0020;
 * services/document-service/src/storage/codec.ts), with Node.js's own SHA-256, so that the
 * universal verifier is checked against a second implementation of the chain.
 */
import { createHash } from 'node:crypto';
import { SERVER_SESSION, type LogCommit } from '@docedit/authority';
import { canonicalize, documentHash, type JsonNode } from '@docedit/model';
import type { Node } from 'prosemirror-model';
import type { BundleCheckpoint, BundleCommit, ChainMetadata, LogBundle } from '../src/chain.ts';

export const DOC = '0192f0c4-7b1e-7000-8000-00000000d0c1';

const sha = (...parts: Buffer[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export function metadataOf(doc: string, c: LogCommit, size: number): ChainMetadata {
  return {
    doc,
    seq: c.seq,
    kind: c.kind,
    id: c.id,
    user: c.user,
    session: c.session === '' || c.session === SERVER_SESSION ? null : c.session,
    agent: c.agent ?? null,
    time: new Date(c.time).toISOString(),
    origin: c.origin,
    scopes: [...c.scopes].sort(),
    base: c.base ?? null,
    rebased: c.rebased ?? null,
    revision: c.revision,
    jti: c.jti ?? null,
    cdm: c.cdm,
    engine: c.engine,
    size,
  };
}

export async function bundleOf(
  log: readonly LogCommit[],
  checkpoints: ReadonlyArray<{ seq: number; doc: Node; carry?: boolean }> = [],
): Promise<LogBundle> {
  const commits: BundleCommit[] = [];
  let prev: Buffer | null = null;
  for (const c of log) {
    const payload = { steps: c.steps, retired: c.retired, claimed: c.claimed };
    const bytes = Buffer.from(canonicalize(payload), 'utf8');
    const meta = metadataOf(DOC, c, bytes.length);
    const payloadHash = sha(bytes);
    const hash = sha(
      prev ?? Buffer.alloc(32),
      Buffer.from(canonicalize(meta), 'utf8'),
      payloadHash,
    );
    commits.push({
      meta,
      payloadHash: payloadHash.toString('hex'),
      prevHash: prev ? prev.toString('hex') : null,
      hash: hash.toString('hex'),
      payload,
    });
    prev = hash;
  }
  const cps: BundleCheckpoint[] = [];
  for (const k of checkpoints) {
    const envelope = { cdm: 1, requires: ['fields'], doc: k.doc.toJSON() as JsonNode };
    cps.push({
      seq: k.seq,
      contentHash: await documentHash(envelope),
      cdm: 1,
      requires: ['fields'],
      ...(k.carry === false ? {} : { content: envelope }),
    });
  }
  return {
    format: 'docedit-log-bundle/1',
    doc: DOC,
    head: { seq: log.length, chainHead: prev ? prev.toString('hex') : null },
    commits,
    checkpoints: cps,
  };
}
