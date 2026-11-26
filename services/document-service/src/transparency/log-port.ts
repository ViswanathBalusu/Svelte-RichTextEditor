/**
 * The `TransparencyLog` port (SEC-066; ADR 0409 decision 4) and the receipt it returns.
 *
 * The document service calls the port with the text of a public entry (SEC-065) and keeps the
 * receipt next to its own signed heads. An adapter talks to one log. A self-hosted operator may
 * point the port at another log or turn it off (`null` in place of a port). Nothing on the commit,
 * open or export path calls it.
 */
import {
  fromHex,
  leafHash,
  openNote,
  parseCheckpointBody,
  rootFromInclusion,
  toHex,
  type LogVerifier,
} from './tlog.ts';

import { LOG_RECEIPT_FORMAT, type PublicLogReceipt } from '@docedit/history';

export { LOG_RECEIPT_FORMAT };

/** What a log gives back for an entry: where it stands and a signed checkpoint that covers it. */
export type LogReceipt = PublicLogReceipt;

export interface TransparencyLog {
  /** The log's identifier, as in `LogReceipt.logId`. */
  readonly id: string;
  /** Adds the entry and returns its receipt. Rejects when the log cannot be reached or refuses. */
  submit(entry: Uint8Array): Promise<LogReceipt>;
  /** The receipt of an entry by its leaf hash, or null when the log does not hold it. */
  getReceipt(leafHashHex: string): Promise<LogReceipt | null>;
}

/** The log could not be reached or refused the entry. A later attempt may work. */
export class TransparencyLogUnavailableError extends Error {
  override name = 'TransparencyLogUnavailableError';
}

/** What a receipt check found, step by step, so that a report can show each result. */
export interface ReceiptCheck {
  /** The leaf hash is the hash of the entry. */
  leaf: boolean;
  /** The checkpoint is signed by the log's key. */
  signature: boolean;
  /** The checkpoint names the receipt's log and size. */
  checkpoint: boolean;
  /** The inclusion proof leads from the leaf to the checkpoint's root. */
  inclusion: boolean;
  /** All four. */
  ok: boolean;
}

/** Checks a receipt for an entry with the log's public key. It needs no network. */
export function checkReceipt(
  entry: Uint8Array,
  receipt: LogReceipt,
  verifier: LogVerifier,
): ReceiptCheck {
  const leaf = leafHash(entry);
  const leafOk = receipt.format === LOG_RECEIPT_FORMAT && toHex(leaf) === receipt.leafHash;
  const body =
    typeof receipt.checkpoint === 'string' ? openNote(receipt.checkpoint, verifier) : null;
  const checkpoint = body === null ? null : parseCheckpointBody(body);
  const signature = body !== null;
  const checkpointOk =
    checkpoint !== null && checkpoint.origin === receipt.logId && checkpoint.size === receipt.size;
  let inclusion = false;
  if (checkpoint !== null && Array.isArray(receipt.proof)) {
    try {
      const root = rootFromInclusion(leaf, receipt.index, receipt.size, receipt.proof.map(fromHex));
      inclusion = root !== null && toHex(root) === checkpoint.root;
    } catch {
      inclusion = false;
    }
  }
  return {
    leaf: leafOk,
    signature,
    checkpoint: checkpointOk,
    inclusion,
    ok: leafOk && signature && checkpointOk && inclusion,
  };
}

/** The receipt as the text stored in write-once storage. */
export function receiptText(r: LogReceipt): string {
  return JSON.stringify({
    format: r.format,
    logId: r.logId,
    index: r.index,
    size: r.size,
    leafHash: r.leafHash,
    proof: r.proof,
    checkpoint: r.checkpoint,
  });
}

/** Reads a stored receipt. Null when it is not one. */
export function parseReceipt(text: string): LogReceipt | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = v as Partial<LogReceipt> | null;
  if (
    typeof o !== 'object' ||
    o === null ||
    o.format !== LOG_RECEIPT_FORMAT ||
    typeof o.logId !== 'string' ||
    !Number.isSafeInteger(o.index) ||
    !Number.isSafeInteger(o.size) ||
    typeof o.leafHash !== 'string' ||
    !Array.isArray(o.proof) ||
    !o.proof.every((p) => typeof p === 'string') ||
    typeof o.checkpoint !== 'string'
  )
    return null;
  return o as LogReceipt;
}
