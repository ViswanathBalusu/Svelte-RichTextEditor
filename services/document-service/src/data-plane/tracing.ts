/**
 * Traces across the planes (06 §11; 05 §5.1 `hello.traceparent`; BE-087, PRO-044). A `hello` that
 * carries a W3C `traceparent` makes the session's work part of that trace: the session, every
 * channel it opens and every commit it submits are spans with the session's trace identifier, as
 * are the checkpoints and outbox deliveries a commit leads to. Without one, the session starts a
 * trace of its own. Spans go to `settings.onSpan`; their attributes are identifiers and codes only
 * (06 §11: never document content or tokens).
 */
import { randomBytes } from 'node:crypto';
import type { Span } from '../seams.ts';

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * The trace and parent span of a `traceparent` header value (W3C Trace Context, version 00), or
 * null when it is malformed or names the all-zero trace or span.
 */
export function parseTraceparent(value: unknown): TraceContext | null {
  if (typeof value !== 'string') return null;
  const m = TRACEPARENT.exec(value.trim());
  if (!m) return null;
  const [, version, traceId, spanId] = m;
  if (version === 'ff' || /^0+$/.test(traceId!) || /^0+$/.test(spanId!)) return null;
  return { traceId: traceId!, spanId: spanId! };
}

export const newTraceId = (): string => randomBytes(16).toString('hex');
export const newSpanId = (): string => randomBytes(8).toString('hex');

/** The `traceparent` value of a context, for passing it on (to a job, for example). */
export function traceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

export interface OpenSpan extends TraceContext {
  /** Ends the span, adding attributes; ending twice records it once. */
  end(attributes?: Readonly<Record<string, string | number | boolean>>): void;
}

export class Tracer {
  readonly #sink: ((span: Span) => void) | undefined;
  readonly #now: () => number;

  constructor(sink: ((span: Span) => void) | undefined, now: () => number = Date.now) {
    this.#sink = sink;
    this.#now = now;
  }

  get enabled(): boolean {
    return this.#sink !== undefined;
  }

  /** Starts a span under `parent`, or a new trace when there is none. */
  start(
    name: string,
    parent: TraceContext | null,
    attributes: Readonly<Record<string, string | number | boolean>> = {},
  ): OpenSpan {
    const traceId = parent?.traceId ?? newTraceId();
    const spanId = newSpanId();
    const start = this.#now();
    let ended = false;
    return {
      traceId,
      spanId,
      end: (more = {}) => {
        if (ended) return;
        ended = true;
        try {
          this.#sink?.({
            name,
            traceId,
            spanId,
            parentSpanId: parent?.spanId ?? null,
            start,
            end: this.#now(),
            attributes: { ...attributes, ...more },
          });
        } catch {
          // A failing sink must not break the work it observes.
        }
      },
    };
  }
}
