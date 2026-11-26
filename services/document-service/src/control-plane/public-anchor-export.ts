/**
 * The public anchor evidence an audit export carries (SEC-067; ADR 0409 decisions 2, 6 and 7; 08
 * §12; HIS-037).
 *
 * For a segment of a document's log, the evidence is the newest published root that covers a head
 * of the document inside the segment: the public entry, the log's receipt for it (null while the
 * root is not yet in the log), and the head with the tenant's salt and the inclusion path. A
 * relying party checks it offline with `scripts/verify-public-anchor.ts`.
 *
 * The salt goes with the evidence because the proof cannot be checked without it. The export is
 * only built for a caller who may read the document's history (the route guards `read.history`),
 * who already holds the document's chain heads. Whether the salt may go to every such caller is the
 * owner's to confirm (SEC-067 notes).
 */
import {
  PUBLIC_ANCHOR_FORMAT,
  type PublicAnchorEvidence,
  type PublicLogReceipt,
} from '@docedit/history';
import { parseReceipt } from '../transparency/log-port.ts';
import type { PublicRootStore, PublicRoots } from './public-root.ts';

/** Where an audit export reads the public anchor evidence of a range. */
export interface PublicAnchorSource {
  evidence(
    tenant: string,
    doc: string,
    range: { from: number; to: number },
  ): Promise<PublicAnchorEvidence[]>;
}

export class PublicAnchorExport implements PublicAnchorSource {
  readonly #roots: PublicRoots;
  readonly #store: PublicRootStore;

  constructor(roots: PublicRoots, store: PublicRootStore) {
    this.#roots = roots;
    this.#store = store;
  }

  /**
   * The newest root that covers a head of the document with a `seq` inside the range, as one piece
   * of evidence; none when no root does (a document with no root yet, a destroyed salt).
   */
  async evidence(
    tenant: string,
    doc: string,
    range: { from: number; to: number },
  ): Promise<PublicAnchorEvidence[]> {
    const roots = (await this.#store.list(tenant)).reverse();
    for (const root of roots) {
      let proof;
      try {
        proof = await this.#roots.proof(tenant, root.to, doc);
      } catch {
        // The document has no head in that period, or its salt cannot be had: try an older root.
        continue;
      }
      if (proof.head.seq > range.to) continue;
      if (proof.head.seq < range.from) return [];
      const receipt: PublicLogReceipt | null =
        root.receipt === null ? null : parseReceipt(root.receipt);
      return [
        {
          format: PUBLIC_ANCHOR_FORMAT,
          doc,
          entry: proof.entry,
          receipt,
          saltVersion: proof.saltVersion,
          salt: proof.salt,
          head: proof.head,
          path: proof.path,
        },
      ];
    }
    return [];
  }
}
