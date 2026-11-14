/**
 * The CloudEvents 1.0 envelope of a webhook body, structured JSON mode (05 §7; ADR 0008; PRO-069).
 *
 * `toCloudEvent` turns an event the control plane raised (`DepEvent`, events.ts) into the body a
 * receiver reads. The body carries `specversion`, `id`, `source`, `type`, `subject`, `time`,
 * `datacontenttype` and `data`. `type` keeps the version suffix (`dep.export.completed.v1`),
 * `subject` is the document identifier, and `data` is small and always includes `seq`; a content
 * change also carries the hash-chain head (`chainHead`, a placeholder name, gaps G83).
 *
 * The rules are those of the published schemas in `spec/dep/webhooks/*.schema.json`: every
 * schema requires `data.seq`, and `dep.document.changed.v1` also requires `data.chainHead`. The
 * builder refuses an event that breaks them, so a body it returns is one the schema accepts for
 * these fields. It does not sign or send anything; the signature is PRO-070 (webhook-signing.ts)
 * and the dispatcher that delivers it is BE-055, not built.
 */
import { randomUUID } from 'node:crypto';
import type { DepEvent } from './events.ts';

export interface CloudEvent {
  specversion: '1.0';
  id: string;
  /** A URI reference that names the emitting service (a setting; for example the endpoint). */
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  data: Record<string, string | number | boolean | null>;
}

export interface EnvelopeOptions {
  /** CloudEvents `source`: a non-empty URI reference. */
  source: string;
  /** Event identifier. A fresh random UUID when absent. */
  id?: string;
}

/** An event name with a version suffix, for example `dep.export.completed.v1`. */
const TYPE_WITH_VERSION = /^dep(\.[a-z][a-z_]*)+\.v[1-9][0-9]*$/;
/** The schema's pattern for `subject`: a UUID version 7. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A SHA-256 hash as lowercase hex. */
const CHAIN_HEAD = /^[0-9a-f]{64}$/;
/** Events about a content change: they must carry the hash-chain head (05 §7). */
const CONTENT_CHANGE: ReadonlySet<string> = new Set(['dep.document.changed.v1']);

export function toCloudEvent(event: DepEvent, opts: EnvelopeOptions): CloudEvent {
  if (!TYPE_WITH_VERSION.test(event.type))
    throw new RangeError(`event type "${event.type}" needs a name and a version suffix`);
  if (!UUID_V7.test(event.subject))
    throw new RangeError('subject must be the document identifier (a UUID version 7)');
  if (opts.source.length === 0) throw new RangeError('source must not be empty');
  const seq = event.data['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0)
    throw new RangeError(`${event.type} needs data.seq, a non-negative integer`);
  if (CONTENT_CHANGE.has(event.type)) {
    const head = event.data['chainHead'];
    if (typeof head !== 'string' || !CHAIN_HEAD.test(head))
      throw new RangeError(`${event.type} needs data.chainHead, a SHA-256 hash in hex`);
  }
  return {
    specversion: '1.0',
    id: opts.id ?? randomUUID(),
    source: opts.source,
    type: event.type,
    subject: event.subject,
    // `toISOString` gives the millisecond form `YYYY-MM-DDTHH:mm:ss.sssZ` the schema asks for.
    time: new Date(event.time).toISOString(),
    datacontenttype: 'application/json',
    data: { ...event.data },
  };
}
