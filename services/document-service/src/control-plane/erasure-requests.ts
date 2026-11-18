/**
 * Erasing a person while a legal hold is in force (HIS-031 criterion 5; owner decision 38 in
 * docs/owner-decisions-2026-11-15.md; 08 §11, §13).
 *
 * The hold wins. A request to erase a person who appears in a document under hold is stored as
 * pending and audited (`erasure.deferred`). When a hold is released the caller asks for
 * `afterRelease`, and each request that no held document still blocks is run and audited
 * (`erasure.run`, with the delay). The rule is `decideErasure` and `releaseDeferred` of
 * `@docedit/history`.
 *
 * The route `POST /users/erase` (operation `erasePerson`, erase-routes.ts) calls `erase` with the
 * service credential's actor (HIS-038 criterion 6).
 *
 * What is not here: a release operation on the hold store (holds.ts has none), a durable store for
 * the pending requests, and the query that lists the documents a person has written in. The last
 * is passed as `documentsOf`. A pending request keeps the surrogate only, never the host `sub`; the `sub` is
 * read back from the mapping row when the request runs.
 */
import {
  decideErasure,
  releaseDeferred,
  type ErasureAudit,
  type PendingErasure,
} from '@docedit/history';
import { uuid7 } from '@docedit/model';
import type { AuditStore } from '../storage/types.ts';
import type { UserDirectory } from './users.ts';

export interface ErasureRequestDeps {
  users: UserDirectory;
  audit: AuditStore;
  /** The documents of the tenant under a legal hold. */
  heldDocuments: (tenant: string) => Promise<ReadonlySet<string>>;
  /** The documents of the tenant in which the person (a surrogate) has written. */
  documentsOf: (tenant: string, surrogate: string) => Promise<Iterable<string>>;
  now: () => number;
}

export type EraseOutcome = 'erased' | 'deferred' | 'unknown_person';

export class ErasureRequests {
  readonly #d: ErasureRequestDeps;
  readonly #pending = new Map<string, PendingErasure[]>();

  constructor(deps: ErasureRequestDeps) {
    this.#d = deps;
  }

  /** The surrogates of the tenant whose erasure waits for a hold, for the operator. */
  pending(tenant: string): readonly PendingErasure[] {
    return this.#pending.get(tenant) ?? [];
  }

  async #audit(tenant: string, actor: string, a: ErasureAudit): Promise<void> {
    const { kind, ...rest } = a;
    await this.#d.audit.record([
      {
        id: uuid7(),
        tenant,
        doc: null,
        actor,
        kind: kind === 'erasure-deferred' ? 'erasure.deferred' : 'erasure.run',
        data: rest,
        at: a.kind === 'erasure-run' ? a.at : a.requestedAt,
      },
    ]);
  }

  /** Erases the person at once, or defers the request while a document of theirs is held. */
  async erase(tenant: string, sub: string, actor: string): Promise<EraseOutcome> {
    // A person the service has never seen is not mapped, so there is nothing to erase and nothing
    // to audit; `resolve` would create the row only to delete it again.
    const surrogate = await this.#d.users.surrogateOf(tenant, sub);
    if (surrogate === null) return 'unknown_person';
    const decision = decideErasure(
      { person: surrogate, requestedBy: actor, requestedAt: this.#d.now() },
      await this.#d.documentsOf(tenant, surrogate),
      await this.#d.heldDocuments(tenant),
    );
    await this.#audit(tenant, actor, decision.audit);
    if (decision.action === 'defer') {
      const list = this.#pending.get(tenant) ?? [];
      if (!list.some((p) => p.person === surrogate)) list.push(decision.pending);
      this.#pending.set(tenant, list);
      return 'deferred';
    }
    return (await this.#d.users.erase(tenant, sub)) ? 'erased' : 'unknown_person';
  }

  /** Runs the pending requests that no held document blocks any more. Returns how many ran. */
  async afterRelease(tenant: string): Promise<number> {
    const now = this.#d.now();
    const r = releaseDeferred(this.pending(tenant), await this.#d.heldDocuments(tenant), now);
    let ran = 0;
    for (const item of r.run) {
      const sub = (await this.#d.users.subsOf(tenant, [item.pending.person])).get(
        item.pending.person,
      );
      if (sub !== undefined) await this.#d.users.erase(tenant, sub);
      await this.#audit(tenant, item.pending.requestedBy, item.audit);
      ran++;
    }
    this.#pending.set(tenant, r.waiting);
    return ran;
  }
}
