/**
 * Events the control plane raises for the webhooks of 05 §7 (`EventSink`, 06 §14). The dispatcher
 * that signs and delivers them (PRO-072) is not built in phase 1a; until it is, events go to the
 * sink the composition chooses. `data` is small and carries identifiers, never content.
 */
export interface DepEvent {
  /** The webhook type with its version suffix, for example `dep.grants.changed.v1`. */
  type: string;
  tenant: string;
  /** The document identifier (CloudEvents `subject`). */
  subject: string;
  data: Record<string, string | number | boolean | null>;
  /** Server time, Unix milliseconds. */
  time: number;
}

export interface EventSink {
  emit(event: DepEvent): void;
}

/** Keeps events in memory, for tests and the memory deployment. */
export class MemoryEventSink implements EventSink {
  readonly events: DepEvent[] = [];

  emit(event: DepEvent): void {
    this.events.push(structuredClone(event));
  }

  of(type: string): DepEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

/** Drops events: for a deployment without webhooks. */
export const NO_EVENTS: EventSink = { emit() {} };
