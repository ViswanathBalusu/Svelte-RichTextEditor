/**
 * PostgreSQL in place of the simulation's in-memory storage (SYN-047). It has the surface of
 * `MemoryStorage` in packages/authority/test/harness/storage.ts, which the test replaces with this
 * class through vi.mock, so sim.ts and the property test run unchanged. Every call goes to the
 * real stores through the synchronous bridge: each simulation is one new document, created with
 * its first revision and claimed (epoch 1, as in the in-memory storage); writes are the real
 * conditional append with the simulation's faults applied to the transaction (src/storage/
 * faults.ts); the log, the permissions and their history are read back from the database.
 */
import type {
  PermissionState,
  RoomInit,
  StoredCommit,
  WriteRequest,
  WriteResult,
} from '@docedit/authority';
import type { SyncBridge } from './sync-bridge.ts';

type Node = RoomInit['initial'];

type Fault = 'none' | 'fail' | 'unknown-applied' | 'unknown-lost';

let bridge: SyncBridge | null = null;

export function useBridge(b: SyncBridge | null): void {
  bridge = b;
}

function call<T>(method: string, args: unknown): T {
  if (!bridge) throw new Error('PgSimStorage: no bridge; the test must call useBridge() first');
  return bridge.call<T>(method, args);
}

export class PgSimStorage {
  readonly initial: Node;
  readonly requires: readonly string[];
  readonly initialRevision: number;
  readonly incarnation: string;
  /** The document this simulation writes to. */
  readonly doc: string;
  writes = 0;
  #history: Map<number, PermissionState> | null = null;

  constructor(initial: Node, requires: readonly string[], perms: PermissionState) {
    this.initial = initial;
    this.requires = requires;
    this.initialRevision = perms.revision;
    const created = call<{ doc: string; incarnation: string; epoch: number }>('create', {
      perms,
      requires: [...requires],
    });
    this.doc = created.doc;
    this.incarnation = created.incarnation;
  }

  get log(): StoredCommit[] {
    return call('log', { doc: this.doc });
  }

  get perms(): PermissionState {
    return call('perms', { doc: this.doc });
  }

  get epoch(): number {
    return call('epoch', { doc: this.doc });
  }

  /** Read from grant_history; read again only after a change, since nothing else adds to it. */
  get permsHistory(): Map<number, PermissionState> {
    this.#history ??= new Map(call<Array<[number, PermissionState]>>('history', { doc: this.doc }));
    return this.#history;
  }

  write(req: WriteRequest, fault: Fault): WriteResult {
    this.writes++;
    // Alternate the point at which a failed write is rolled back: before the inserts or after.
    const failAt = req.fromSeq % 2 === 0 ? 'before-insert' : 'before-commit';
    return call('write', { doc: this.doc, req, fault, failAt });
  }

  changePermissions(f: (p: PermissionState) => Omit<PermissionState, 'revision'>): PermissionState {
    const desired = f(this.perms);
    const next = call<PermissionState>('change', { doc: this.doc, desired });
    this.#history = null;
    return next;
  }

  claimOwnership(): number {
    return call('claim', { doc: this.doc });
  }
}
