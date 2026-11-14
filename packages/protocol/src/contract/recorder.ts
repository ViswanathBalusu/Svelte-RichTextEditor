/**
 * Records everything a channel delivers, in order, and waits for expected messages with a timeout.
 */
import type { SyncChannel } from '../ports/core.ts';
import type {
  Access,
  ChannelState,
  Notification,
  RemoteCommit,
  SyncCheck,
  SyncReset,
  Unsubscribe,
} from '../ports/types.ts';
import { ContractFailure } from './assert.ts';
import type { ContractOptions } from './harness.ts';

export type Delivered =
  | { kind: 'commits'; value: RemoteCommit[] }
  | { kind: 'reset'; value: SyncReset }
  | { kind: 'access'; value: Access }
  | { kind: 'event'; value: Notification }
  | { kind: 'state'; value: ChannelState }
  | { kind: 'check'; value: SyncCheck }
  | { kind: 'ack'; value: { seq: number; id: string } };

export class Recorder {
  readonly log: Delivered[] = [];
  private readonly offs: Unsubscribe[] = [];
  private readonly waiters = new Set<() => void>();
  /** True while an `on…` registration is running; a callback seen then was called synchronously. */
  private registering = false;
  syncCallbacks = 0;
  readonly channel: SyncChannel;
  private readonly opts: ContractOptions;

  constructor(channel: SyncChannel, opts: ContractOptions) {
    this.channel = channel;
    this.opts = opts;
    const on = (kind: Delivered['kind'], sub: (cb: (v: unknown) => void) => Unsubscribe) => {
      this.registering = true;
      this.offs.push(
        sub((value: unknown) => {
          if (this.registering) this.syncCallbacks++;
          this.add({ kind, value } as Delivered);
        }),
      );
      this.registering = false;
    };
    on('commits', (cb) => channel.onCommits(cb));
    on('reset', (cb) => channel.onReset(cb));
    on('access', (cb) => channel.onAccess(cb));
    on('event', (cb) => channel.onEvent(cb));
    on('state', (cb) => channel.onState(cb));
    on('check', (cb) => channel.onCheck(cb));
  }

  /** Records an acknowledgement in the same log, for order checks. */
  ack(a: { seq: number; id: string }): void {
    this.add({ kind: 'ack', value: { seq: a.seq, id: a.id } });
  }

  private add(d: Delivered): void {
    this.log.push(d);
    for (const w of [...this.waiters]) w();
  }

  get commits(): RemoteCommit[] {
    return this.log.flatMap((d) => (d.kind === 'commits' ? d.value : []));
  }

  get accesses(): Access[] {
    return this.log.flatMap((d) => (d.kind === 'access' ? [d.value] : []));
  }

  get states(): ChannelState[] {
    return this.log.flatMap((d) => (d.kind === 'state' ? [d.value] : []));
  }

  get events(): Notification[] {
    return this.log.flatMap((d) => (d.kind === 'event' ? [d.value] : []));
  }

  get resets(): SyncReset[] {
    return this.log.flatMap((d) => (d.kind === 'reset' ? [d.value] : []));
  }

  get checks(): SyncCheck[] {
    return this.log.flatMap((d) => (d.kind === 'check' ? [d.value] : []));
  }

  /** Waits until `pred` holds, failing after the suite's timeout. */
  async until(pred: () => boolean, what: string): Promise<void> {
    if (pred()) return;
    let done!: () => void;
    const reached = new Promise<void>((resolve) => {
      done = () => {
        if (pred()) resolve();
      };
    });
    this.waiters.add(done);
    let timedOut = false;
    const timeout = this.opts.sleep(this.opts.timeoutMs ?? 5000).then(() => {
      timedOut = true;
    });
    try {
      await Promise.race([reached, timeout]);
    } finally {
      this.waiters.delete(done);
    }
    if (timedOut && !pred())
      throw new ContractFailure(
        `timed out waiting for ${what}; delivered: ${JSON.stringify(this.log.map((d) => d.kind))}`,
      );
  }

  /** Waits for a commit with this `seq`. */
  untilSeq(seq: number): Promise<void> {
    return this.until(() => this.commits.some((c) => c.seq === seq), `commit ${seq}`);
  }

  /** Waits for a channel state with this status. */
  untilState(status: ChannelState['status']): Promise<void> {
    return this.until(() => this.states.some((s) => s.status === status), `state ${status}`);
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
