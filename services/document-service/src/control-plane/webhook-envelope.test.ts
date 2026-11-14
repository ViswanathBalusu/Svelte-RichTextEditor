// CloudEvents envelope of webhook bodies (05 §7; PRO-069). These tests cover the body the builder
// returns. They do not cover the dispatcher that delivers it (BE-055), and they do not validate
// against the full JSON Schema of spec/dep/webhooks (no JSON Schema validator is a dependency of
// this package); the schema's required fields and patterns are checked by hand below.
import { describe, expect, it } from 'vitest';
import type { DepEvent } from './events.ts';
import { toCloudEvent } from './webhook-envelope.ts';

const DOC = '0190d2a4-7c3e-7b1a-9f00-1234567890ab';
const HEAD = 'a'.repeat(64);
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0, 123);

function event(over: Partial<DepEvent> & { data?: DepEvent['data'] } = {}): DepEvent {
  return {
    type: 'dep.export.completed.v1',
    tenant: 'acme',
    subject: DOC,
    data: { seq: 7, job: 'j1' },
    time: NOW,
    ...over,
  };
}

const SOURCE = 'https://docs.example.com';

describe('PRO-069 the body is a CloudEvents 1.0 document in structured JSON mode', () => {
  it('carries specversion, id, source, type, subject, time, datacontenttype and data', () => {
    const body = toCloudEvent(event(), { source: SOURCE, id: 'evt-1' });
    expect(Object.keys(body).sort()).toEqual(
      ['specversion', 'id', 'source', 'type', 'subject', 'time', 'datacontenttype', 'data'].sort(),
    );
    expect(body).toEqual({
      specversion: '1.0',
      id: 'evt-1',
      source: SOURCE,
      type: 'dep.export.completed.v1',
      subject: DOC,
      time: '2026-11-13T12:00:00.123Z',
      datacontenttype: 'application/json',
      data: { seq: 7, job: 'j1' },
    });
  });

  it('survives a JSON round trip unchanged, so it can be sent as the request body', () => {
    const body = toCloudEvent(event(), { source: SOURCE, id: 'evt-2' });
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it('draws a fresh id for each body when none is given', () => {
    const a = toCloudEvent(event(), { source: SOURCE });
    const b = toCloudEvent(event(), { source: SOURCE });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('copies data, so that a later change to the event does not reach the body', () => {
    const ev = event();
    const body = toCloudEvent(ev, { source: SOURCE, id: 'x' });
    ev.data['seq'] = 99;
    expect(body.data['seq']).toBe(7);
  });
});

describe('PRO-069 type carries the version suffix and subject is the document identifier', () => {
  it.each([
    'dep.export.completed.v1',
    'dep.document.state_changed.v1',
    'dep.comment.mentioned.v1',
    'dep.grants.changed.v2',
  ])('keeps the type %s as it is given', (type) => {
    expect(
      toCloudEvent(event({ type, data: { seq: 1, chainHead: HEAD } }), { source: SOURCE }).type,
    ).toBe(type);
  });

  it('refuses a type without a version suffix', () => {
    expect(() => toCloudEvent(event({ type: 'dep.export.completed' }), { source: SOURCE })).toThrow(
      RangeError,
    );
  });

  it('refuses a type with a version of zero or with no dep prefix', () => {
    expect(() =>
      toCloudEvent(event({ type: 'dep.export.completed.v0' }), { source: SOURCE }),
    ).toThrow();
    expect(() =>
      toCloudEvent(event({ type: 'export.completed.v1' }), { source: SOURCE }),
    ).toThrow();
  });

  it('refuses a subject that is not a UUID version 7 document identifier', () => {
    expect(() => toCloudEvent(event({ subject: 'doc-1' }), { source: SOURCE })).toThrow(RangeError);
    expect(() =>
      toCloudEvent(event({ subject: '0190d2a4-7c3e-4b1a-9f00-1234567890ab' }), { source: SOURCE }),
    ).toThrow(RangeError);
  });
});

describe('PRO-069 data is small and includes seq; content changes include the hash-chain head', () => {
  it('refuses an event whose data has no seq', () => {
    expect(() => toCloudEvent(event({ data: { job: 'j1' } }), { source: SOURCE })).toThrow(
      /data\.seq/,
    );
  });

  it('refuses a seq that is not a non-negative integer', () => {
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, 'seven'] as const) {
      expect(() =>
        toCloudEvent(event({ data: { seq: seq as unknown as number } }), { source: SOURCE }),
      ).toThrow(/data\.seq/);
    }
  });

  it('refuses dep.document.changed without the hash-chain head', () => {
    expect(() =>
      toCloudEvent(event({ type: 'dep.document.changed.v1', data: { seq: 3 } }), {
        source: SOURCE,
      }),
    ).toThrow(/chainHead/);
  });

  it('refuses a hash-chain head that is not 64 lowercase hex digits', () => {
    expect(() =>
      toCloudEvent(event({ type: 'dep.document.changed.v1', data: { seq: 3, chainHead: 'ABC' } }), {
        source: SOURCE,
      }),
    ).toThrow(/chainHead/);
  });

  it('keeps seq and the hash-chain head of a content change', () => {
    const body = toCloudEvent(
      event({ type: 'dep.document.changed.v1', data: { seq: 3, chainHead: HEAD } }),
      { source: SOURCE, id: 'c1' },
    );
    expect(body.data).toEqual({ seq: 3, chainHead: HEAD });
  });

  it('keeps the schema pattern for time: milliseconds and Z', () => {
    const body = toCloudEvent(event(), { source: SOURCE, id: 'x' });
    expect(body.time).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
  });

  it('refuses an empty source', () => {
    expect(() => toCloudEvent(event(), { source: '' })).toThrow(RangeError);
  });
});
