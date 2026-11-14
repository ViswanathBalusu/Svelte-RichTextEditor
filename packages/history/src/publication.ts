/**
 * Publishing a document's chain head to the host (08 §12; 05 §7; HIS-034 criteria 1, 2 and 4).
 *
 * The webhook `dep.document.changed` carries the `seq` and the chain head of the content, and it is
 * debounced to at most one per `PUBLISH_INTERVAL_MS` per document (05 §7). This module holds that
 * rule and nothing else: which head may be published (only the head of a durable commit, never of
 * a tentative one), when the next publication may go, and the final publication once the window
 * ends, so that the last state is not left unannounced. The document service feeds it the server
 * time and the commits as they become durable, and raises the webhook with what it returns.
 *
 * Time is passed in (Unix milliseconds), so the rule is a pure function of its inputs. Heads only
 * move forward: a durable head at or below the one already published is not published again.
 */
import { type HistoryError, type HistoryResult, refuse } from './types.ts';

/** 05 §7: the webhook is debounced to at most one per 10 seconds per document. */
export const PUBLISH_INTERVAL_MS = 10_000;

/** A commit's head as the service knows it at one moment. */
export interface HeadObservation {
  /** The sequence number of the commit. */
  seq: number;
  /** Its chain hash, or null where the chain has no hash for it (08 §2). */
  chainHead: string | null;
  /** Whether the commit is durable: stored and acknowledged, not tentative (HIS-034 criterion 4). */
  durable: boolean;
}

/** The data of one `dep.document.changed` webhook (HIS-034 criterion 1). */
export interface HeadPublication {
  seq: number;
  chainHead: string | null;
  /** Server time of the publication, Unix milliseconds. */
  at: number;
}

export interface PublisherStep {
  /** The publication to raise now, when one is due; otherwise null. */
  publish: HeadPublication | null;
  /** Server time at which the next pending publication becomes due, or null when none waits. */
  nextAt: number | null;
}

/**
 * Debounces the head of one document. Feed it observations with `observe` as commits become
 * durable, and call `poll` at `nextAt` (or on any later tick) to publish a head that waited for the
 * window to end. A document publishes at once when no publication was made in the last window.
 */
export class HeadPublisher {
  private published: HeadPublication | null = null;
  private pending: HeadObservation | null = null;
  private lastTime: number | null = null;

  /** The head most recently published, or null before the first publication. */
  get lastPublished(): HeadPublication | null {
    return this.published;
  }

  /**
   * Records a durable head seen at `now` and publishes it when the window allows. A tentative head
   * is ignored, and a head at or below the one already published is ignored (heads only move on).
   */
  observe(now: number, head: HeadObservation): HistoryResult<PublisherStep> {
    if (!Number.isSafeInteger(now)) return refuse('validation_failed', 'now is a whole time');
    if (!Number.isSafeInteger(head.seq) || head.seq < 1)
      return refuse('validation_failed', 'a head names a commit seq');
    const late = this.clock(now);
    if (late) return late;
    if (!head.durable) return { ok: true, ...this.step(now) };
    const published = this.published?.seq ?? 0;
    if (head.seq > published && (this.pending === null || head.seq > this.pending.seq))
      this.pending = head;
    return { ok: true, ...this.step(now) };
  }

  /** Publishes the pending head when the window has ended (the final publication, criterion 2). */
  poll(now: number): HistoryResult<PublisherStep> {
    if (!Number.isSafeInteger(now)) return refuse('validation_failed', 'now is a whole time');
    const late = this.clock(now);
    if (late) return late;
    return { ok: true, ...this.step(now) };
  }

  /** Times must not move backwards; a refused time changes nothing. */
  private clock(now: number): HistoryError | null {
    if (this.lastTime !== null && now < this.lastTime)
      return refuse('validation_failed', 'the server time moved backwards');
    this.lastTime = now;
    return null;
  }

  private step(now: number): PublisherStep {
    const due = this.published === null || now - this.published.at >= PUBLISH_INTERVAL_MS;
    if (this.pending !== null && due) {
      const p = this.pending;
      this.pending = null;
      this.published = { seq: p.seq, chainHead: p.chainHead, at: now };
      return { publish: this.published, nextAt: null };
    }
    const nextAt =
      this.pending !== null && this.published !== null
        ? this.published.at + PUBLISH_INTERVAL_MS
        : null;
    return { publish: null, nextAt };
  }
}
