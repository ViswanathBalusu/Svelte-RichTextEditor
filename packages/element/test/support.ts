// Shared helpers for the element's Node.js tests: a recording host, a stand-in for the mounted
// editor, and the mock backend (packages/backend-mock) with the contract document.
import { MockService, type GrantSpec } from '@docedit/backend-mock';
import { IDS, USERS, contractDocument } from '@docedit/protocol/contract';
import type { Access, Content, DocRole, SyncChannel } from '@docedit/protocol';
import type {
  Connection,
  DocEditorEventMap,
  DocEditorEventName,
  StatusDetail,
  SyncState,
} from '../src/events.ts';
import type { AttachAt, EditorHandle, ReadView, SessionHost } from '../src/session.ts';
import { connectionOf, mayChange } from '../src/status.ts';

export { IDS, USERS, contractDocument };

/** The grant that opens the restricted region to the `legal` group (as in the contract suite). */
export const LEGAL_GRANT: GrantSpec = {
  region: IDS.locked,
  principal: 'group:legal',
  role: 'editor',
};

/** A read view that notifies at once. */
export class Value<T> implements ReadView<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();
  constructor(value: T) {
    this.#value = value;
  }
  get(): T {
    return this.#value;
  }
  set(value: T): void {
    this.#value = value;
    for (const l of [...this.#listeners]) l();
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export interface Recorded {
  name: DocEditorEventName;
  detail: unknown;
}

export interface FakeEditor {
  handle: EditorHandle;
  saveState: Value<SyncState>;
  confirmed: Value<number>;
  access: Value<Access | null>;
  recovered: Value<{ count: number }>;
  problem: Value<{ n: number; code: string; message: string; fatal: boolean } | null>;
  attached: SyncChannel[];
  attachedWith: AttachAt[];
  mounted: Content[];
  destroyed: number;
}

/**
 * A stand-in for the mounted editor that behaves like the core's views: on attach it takes the
 * access and the channel state from the channel, as the engine's sync client does.
 */
export function fakeEditor(): FakeEditor {
  const fake: FakeEditor = {
    saveState: new Value<SyncState>('saved'),
    confirmed: new Value(0),
    access: new Value<Access | null>(null),
    recovered: new Value({ count: 0 }),
    problem: new Value<{ n: number; code: string; message: string; fatal: boolean } | null>(null),
    attached: [],
    attachedWith: [],
    mounted: [],
    destroyed: 0,
    handle: undefined as unknown as EditorHandle,
  };
  const connection = new Value<Connection>('offline');
  const status: ReadView<StatusDetail> = {
    get: () => {
      const a = fake.access.get();
      return {
        connection: connection.get(),
        sync: a && !mayChange(a) ? 'readonly' : fake.saveState.get(),
      };
    },
    subscribe: (l) => {
      const stops = [
        connection.subscribe(l),
        fake.saveState.subscribe(l),
        fake.access.subscribe(l),
      ];
      return () => stops.forEach((s) => s());
    },
  };
  fake.handle = {
    attach(channel, at) {
      fake.attached.push(channel);
      fake.attachedWith.push(at);
      fake.access.set(channel.opened.access);
      connection.set('online');
      const stops = [
        channel.onAccess((a) => fake.access.set(a)),
        channel.onState((s) => connection.set(connectionOf(s.status))),
      ];
      return () => stops.forEach((s) => s());
    },
    setAccess(access) {
      fake.access.set(access);
    },
    saveState: fake.saveState,
    confirmedSeq: fake.confirmed,
    access: fake.access,
    status,
    recovered: fake.recovered,
    problem: fake.problem,
    focus() {},
    destroy() {
      fake.destroyed++;
    },
  };
  return fake;
}

export function recordingHost(editor: FakeEditor): SessionHost & { events: Recorded[] } {
  const events: Recorded[] = [];
  return {
    events,
    emit<K extends DocEditorEventName>(name: K, detail: DocEditorEventMap[K]) {
      events.push({ name, detail: structuredClone(detail) });
    },
    async mount(content) {
      editor.mounted.push(content);
      if (editor.handle.confirmedSeq !== null) editor.confirmed.set(content.seq);
      return editor.handle;
    },
  };
}

/** Lets microtasks and queued deliveries run. */
export async function settle(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function names(events: readonly Recorded[]): string[] {
  return events.map((e) => e.name);
}

export function service(): { service: MockService; docId: string } {
  const s = new MockService();
  const docId = s.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  return { service: s, docId };
}

export function backendFor(s: MockService, docId: string, who: keyof typeof USERS, role: DocRole) {
  return s.backend(USERS[who], { [docId]: role });
}

/** A manual scheduler: frames run only when `flush()` is called. */
export function manualFrames(): {
  schedule: (run: () => void) => void;
  flush(): void;
  pending(): number;
} {
  let queue: Array<() => void> = [];
  return {
    schedule: (run) => {
      queue.push(run);
    },
    flush() {
      const runs = queue;
      queue = [];
      for (const r of runs) r();
    },
    pending: () => queue.length,
  };
}
