/**
 * Submitting the public roots to a transparency log and keeping the receipts (SEC-066; ADR 0409
 * decisions 4 and 6; 10 §6; 08 §12).
 *
 * `PublicRootAnchors.submitPending` takes the tenant's roots that have no receipt, oldest first, and
 * sends the text of each public entry (SEC-065) through the `TransparencyLog` port. On success it
 * writes the receipt to write-once storage next to the signed heads and keeps it with the root. On
 * failure it changes nothing that says "anchored", tells the operator, and stops: the root stays in
 * write-once storage (`PublicRoots.run` wrote it before this ran) and the next run tries again.
 * Nothing here is on the path of a commit, an open or an export: rooms and workers neither call
 * this nor wait for it.
 *
 * With the port off (`log: null`) nothing is sent, and `publicAnchorReport` says that no public
 * anchor exists for the tenant. A self-hosted operator may point the port at another log.
 */
import { uuid7 } from '@docedit/model';
import { objectKeys } from '../objects/store.ts';
import type { AuditStore } from '../storage/types.ts';
import {
  parseReceipt,
  receiptText,
  type LogReceipt,
  type TransparencyLog,
} from '../transparency/log-port.ts';
import type { HeadAnchorFiles } from './head-anchoring.ts';
import type { PublicRootStore, StoredPublicRoot } from './public-root.ts';
import type { ScheduledTask } from './scheduler.ts';

export interface PublicRootAnchorsDeps {
  store: PublicRootStore;
  /** The log, or null when the port is turned off. */
  log: TransparencyLog | null;
  files: HeadAnchorFiles;
  audit: AuditStore;
  /** How long a receipt is retained in write-once storage, ms from the period's end. */
  retainMs: number;
  now: () => number;
}

export interface SubmitRun {
  /** Roots that got a receipt in this run. */
  submitted: number;
  /** Roots that still have none. */
  pending: number;
  /** True when the port is off: nothing was sent. */
  off: boolean;
  /** The first failure, which stopped the run; null when none. */
  failure: { to: string; code: string } | null;
}

/** What `publicAnchorReport` says about a tenant. */
export interface PublicAnchorReport {
  /**
   * `off`: the port is turned off, so no public anchor exists. `none`: the tenant has no root.
   * `pending`: roots exist and the newest has no receipt. `anchored`: the newest has one.
   */
  state: 'off' | 'none' | 'pending' | 'anchored';
  /** The log's identifier, or null when the port is off. */
  log: string | null;
  roots: number;
  withReceipt: number;
  /** The newest root's period end and receipt, if it has one. */
  newest: { to: string; receipt: LogReceipt | null } | null;
  /** A sentence for a person to read. */
  message: string;
}

export class PublicRootAnchors {
  readonly #d: PublicRootAnchorsDeps;

  constructor(deps: PublicRootAnchorsDeps) {
    if (!Number.isSafeInteger(deps.retainMs) || deps.retainMs < 1)
      throw new RangeError('public root anchors: retainMs must be a positive whole number');
    this.#d = deps;
  }

  /** One attempt for every root of the tenant that has no receipt. It never rejects for a log fault. */
  async submitPending(tenant: string, now: number = this.#d.now()): Promise<SubmitRun> {
    const { store, log, files } = this.#d;
    const roots = (await store.list(tenant)).filter((r) => r.receipt === null);
    if (log === null) return { submitted: 0, pending: roots.length, off: true, failure: null };
    let submitted = 0;
    for (const root of roots) {
      let receipt: LogReceipt;
      try {
        receipt = await log.submit(new TextEncoder().encode(root.entry));
      } catch (e) {
        const code = e instanceof Error ? e.name : 'failed';
        await this.#audit(tenant, now, 'public-root.submit-failed', { to: root.to, code });
        return {
          submitted,
          pending: roots.length - submitted,
          off: false,
          failure: { to: root.to, code },
        };
      }
      const text = receiptText(receipt);
      try {
        await files.put(
          objectKeys.publicRootReceipt(tenant, root.to),
          new TextEncoder().encode(`${text}\n`),
          Date.parse(root.to) + this.#d.retainMs,
        );
      } catch (e) {
        // The log has the entry; a later run submits again, gets the same index, and writes it.
        const code = e instanceof Error ? e.name : 'failed';
        await this.#audit(tenant, now, 'public-root.submit-failed', { to: root.to, code });
        return {
          submitted,
          pending: roots.length - submitted,
          off: false,
          failure: { to: root.to, code },
        };
      }
      await store.setReceipt(tenant, root.to, text);
      await this.#audit(tenant, now, 'public-root.receipt', {
        to: root.to,
        log: receipt.logId,
        index: receipt.index,
        size: receipt.size,
      });
      submitted++;
    }
    return { submitted, pending: 0, off: false, failure: null };
  }

  /** What a verification report says about the tenant's public anchor. */
  async report(tenant: string): Promise<PublicAnchorReport> {
    const roots = await this.#d.store.list(tenant);
    const withReceipt = roots.filter((r) => r.receipt !== null).length;
    const last: StoredPublicRoot | undefined = roots[roots.length - 1];
    const newest =
      last === undefined
        ? null
        : { to: last.to, receipt: last.receipt === null ? null : parseReceipt(last.receipt) };
    if (this.#d.log === null)
      return {
        state: 'off',
        log: null,
        roots: roots.length,
        withReceipt,
        newest,
        message:
          'No public anchor exists for this tenant: the transparency log is turned off. History is anchored by the signed heads in write-once storage only.',
      };
    if (last === undefined)
      return {
        state: 'none',
        log: this.#d.log.id,
        roots: 0,
        withReceipt: 0,
        newest: null,
        message: 'The tenant has no public root yet.',
      };
    const anchored = last.receipt !== null;
    return {
      state: anchored ? 'anchored' : 'pending',
      log: this.#d.log.id,
      roots: roots.length,
      withReceipt,
      newest,
      message: anchored
        ? `The newest root, for the period ending ${last.to}, is in the log ${this.#d.log.id}.`
        : `The newest root, for the period ending ${last.to}, is not yet in the log ${this.#d.log.id}.`,
    };
  }

  async #audit(
    tenant: string,
    at: number,
    kind: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    // The audit event holds the period, the log and the index; never the salt or a head.
    await this.#d.audit
      .record([{ id: uuid7(), tenant, doc: null, actor: 'system', kind, data, at }])
      .catch(() => undefined);
  }
}

/** What the operator is told when a run could not submit. */
export interface SubmitFailure {
  tenant: string;
  to: string;
  code: string;
}

/**
 * The scheduled task (BE-052): per tenant, every `everyMs`, it submits the roots that have no
 * receipt. The period of the roots themselves is `PublicRoots` scheduling (no default is fixed:
 * ADR 0409 decision 3). Its count is the number of receipts stored. A run that could not submit
 * tells `onFailure` and rejects, so that the scheduler counts it as failed; the next run retries.
 */
export function publicRootSubmitTask(
  anchors: PublicRootAnchors,
  everyMs: number,
  onFailure?: (failure: SubmitFailure) => void | Promise<void>,
): ScheduledTask {
  return {
    name: 'public-root.submit',
    everyMs,
    forTenant: async (tenant: string, at: number) => {
      const run = await anchors.submitPending(tenant, at);
      if (run.failure !== null) {
        await Promise.resolve(
          onFailure?.({ tenant, to: run.failure.to, code: run.failure.code }),
        ).catch(() => undefined);
        throw new Error(`public root submission failed at ${run.failure.to}: ${run.failure.code}`);
      }
      return run.submitted;
    },
  };
}
