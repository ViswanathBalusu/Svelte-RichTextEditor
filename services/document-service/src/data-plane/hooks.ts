/**
 * Fault injection for the conformance kit (05 §11; 06 §8; BE-079). The hooks exist only in test
 * mode, which is off by default and refused when NODE_ENV is `production`; the composition decides
 * how the kit reaches them. They can make the database unreachable for the node, fail the next
 * write of a document before its insert or after it, kill a room as a crash would, drop one grant
 * announcement, rewind the log of a document with a new incarnation (the in-memory store only),
 * and read a document's chain head, ownership epoch and audit events. Every use is
 * logged and, with an audit trail, recorded in it (criterion 5).
 */
import { uuid7 } from '@docedit/model';
import type { DataPlaneTestHooks } from '../seams.ts';
import type { AuditStore, DocRef, LogStore } from '../storage/types.ts';

const refKey = (ref: DocRef) => `${ref.tenant}/${ref.doc}`;

/** The faults the hooks set; rooms consult them on every write and every announcement. */
export class Faults {
  databaseDown = false;
  readonly #failNext = new Map<string, 'before-insert' | 'after-insert'>();
  readonly #dropAnnouncement = new Set<string>();

  failNext(ref: DocRef, at: 'before-insert' | 'after-insert'): void {
    this.#failNext.set(refKey(ref), at);
  }

  /** The fault for the next write of `ref`, consumed. */
  takeFailNext(ref: DocRef): 'before-insert' | 'after-insert' | undefined {
    const k = refKey(ref);
    const f = this.#failNext.get(k);
    if (f) this.#failNext.delete(k);
    return f;
  }

  dropNextAnnouncement(ref: DocRef): void {
    this.#dropAnnouncement.add(refKey(ref));
  }

  /** Whether this announcement is dropped, consumed. */
  takeDrop(ref: DocRef): boolean {
    return this.#dropAnnouncement.delete(refKey(ref));
  }
}

export interface HookDeps {
  faults: Faults;
  logs: LogStore;
  audit: AuditStore | undefined;
  now: () => number;
  /** Stops the room of a document without release or checkpoint; false when none is open. */
  kill(ref: DocRef): Promise<boolean>;
  /** A structured log line. */
  log(fields: Record<string, unknown>): void;
}

export function testHooks(d: HookDeps): DataPlaneTestHooks {
  // Reads are logged; changes are also recorded in the audit trail.
  const used = (hook: string, ref?: DocRef, extra: Record<string, unknown> = {}, audit = true) => {
    d.log({
      event: 'data-plane.test-hook',
      hook,
      ...(ref ? { tenant: ref.tenant, doc: ref.doc } : {}),
      ...extra,
    });
    if (audit && d.audit && ref)
      d.audit
        .record([
          {
            id: uuid7(),
            tenant: ref.tenant,
            doc: ref.doc,
            actor: 'system',
            kind: 'test.hook',
            data: { hook, ...extra },
            at: d.now(),
          },
        ])
        .catch(() => {});
  };
  return {
    dropDatabase(down) {
      d.faults.databaseDown = down;
      used('dropDatabase', undefined, { down });
    },
    failNextWrite(ref, at) {
      d.faults.failNext(ref, at);
      used('failNextWrite', ref, { at });
    },
    async killRoom(ref) {
      used('killRoom', ref);
      return d.kill(ref);
    },
    dropNextAnnouncement(ref) {
      d.faults.dropNextAnnouncement(ref);
      used('dropNextAnnouncement', ref);
    },
    async rewind(ref, head) {
      // Only a store that can be rewound (the in-memory one) supports it; PostgreSQL has no such
      // hook, because a restored database is the operator's procedure (BE-078).
      const logs = d.logs as LogStore & {
        rewindForTest?(ref: DocRef, head: number): void;
        newIncarnation?(ref: DocRef, incarnation: string): Promise<{ before: string }>;
      };
      if (typeof logs.rewindForTest !== 'function' || typeof logs.newIncarnation !== 'function')
        return null;
      used('rewind', ref, { head });
      await d.kill(ref);
      logs.rewindForTest(ref, head);
      const incarnation = uuid7();
      await logs.newIncarnation(ref, incarnation);
      return { head, incarnation };
    },
    async state(ref) {
      used('state', ref, {}, false);
      // PgLogStore and MemoryStore read the chain head; a store without `state` has none to give.
      if (d.logs.state) return d.logs.state(ref);
      const h = await d.logs.head(ref);
      return {
        seq: h.seq,
        epoch: h.epoch,
        owner: h.owner,
        incarnation: h.incarnation,
        chainHead: null,
      };
    },
    async auditEvents(ref) {
      used('auditEvents', ref, {}, false);
      return d.audit ? d.audit.query(ref.tenant, { doc: ref.doc, limit: 1000 }) : [];
    },
  };
}
