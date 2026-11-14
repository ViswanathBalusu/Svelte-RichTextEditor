// Webhook bodies for permission events and the throttle of rejections (PRM-053 criteria 4 and 5).
// Delivery itself is the host's (BE-055), so criteria 1 to 3 are not tested here.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EVENT_DATA_KEYS,
  PERMISSION_EVENT_TYPES,
  carriesNoContent,
  commitRejectedEvent,
  createThrottle,
  grantsChangedEvent,
  regionStateChangedEvent,
} from '../src/index.ts';

const envelopeArb = fc.record({
  id: fc.uuid(),
  source: fc.constantFrom('dep-svc', 'authority'),
  document: fc.stringMatching(/^[a-z0-9]{1,20}$/),
  seq: fc.nat({ max: 1_000_000 }),
  now: fc.integer({ min: 0, max: 4_000_000_000_000 }),
});

describe('permission event bodies (PRM-053 criterion 4)', () => {
  it('builds small CloudEvents 1.0 whose subject is the document and whose data carries the seq (property)', () => {
    fc.assert(
      fc.property(
        envelopeArb,
        fc.nat({ max: 50 }),
        fc.constantFrom('draft', 'in_review', 'approved'),
        fc.constantFrom('permission_denied', 'invalid_op'),
        fc.stringMatching(/^r[A-Za-z0-9]{1,16}$/),
        (e, revision, state, code, region) => {
          const events = [
            grantsChangedEvent({ ...e, revision }),
            regionStateChangedEvent({ ...e, region, state }),
            commitRejectedEvent({ ...e, code }),
          ];
          const types = [
            PERMISSION_EVENT_TYPES.grantsChanged,
            PERMISSION_EVENT_TYPES.regionStateChanged,
            PERMISSION_EVENT_TYPES.commitRejected,
          ];
          events.forEach((ev, i) => {
            expect(ev).not.toBeNull();
            expect(ev!.specversion).toBe('1.0');
            expect(ev!.id).toBe(e.id);
            expect(ev!.source).toBe(e.source);
            expect(ev!.type).toBe(types[i]);
            expect(ev!.subject).toBe(e.document);
            expect(ev!.data.seq).toBe(e.seq);
            expect(ev!.datacontenttype).toBe('application/json');
            expect(new Date(ev!.time).getTime()).toBe(e.now);
            expect(carriesNoContent(ev!)).toBe(true);
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it('puts only identifiers, numbers and labels in data, never steps, text or content (property)', () => {
    fc.assert(
      fc.property(envelopeArb, fc.nat({ max: 50 }), (e, revision) => {
        const ev = grantsChangedEvent({ ...e, revision });
        for (const forbidden of ['steps', 'text', 'content', 'marks', 'attrs', 'doc'])
          expect(Object.keys(ev.data)).not.toContain(forbidden);
        expect(
          Object.keys(ev.data).every((k) => (EVENT_DATA_KEYS as readonly string[]).includes(k)),
        ).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('refuses to build a rejection event for any refusal other than the two of 05 §7', () => {
    const e = { id: 'x', source: 's', document: 'd', seq: 3, now: 0 };
    expect(commitRejectedEvent({ ...e, code: 'permission_denied' })).not.toBeNull();
    expect(commitRejectedEvent({ ...e, code: 'invalid_op' })).not.toBeNull();
    expect(commitRejectedEvent({ ...e, code: 'conflict' as never })).toBeNull();
    expect(commitRejectedEvent({ ...e, code: 'rate_limited' as never })).toBeNull();
  });

  it('flags a body that carries a key the events do not allow', () => {
    const ev = grantsChangedEvent({
      id: 'x',
      source: 's',
      document: 'd',
      seq: 1,
      now: 0,
      revision: 1,
    });
    expect(carriesNoContent({ ...ev, data: { ...ev.data, text: 'hello' } as never })).toBe(false);
    expect(carriesNoContent({ ...ev, data: { seq: 1, text: 'x'.repeat(300) } as never })).toBe(
      false,
    );
  });
});

describe('the throttle of rejections (PRM-053 criterion 5)', () => {
  it('never allows more than the limit in any window, whatever the arrival times (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.array(fc.nat({ max: 400 }), { maxLength: 200 }),
        (limit, windowMs, gaps) => {
          const t = createThrottle({ limit, windowMs });
          let now = 0;
          const delivered: number[] = [];
          for (const g of gaps) {
            now += g;
            if (t.offer(now) === 'deliver') delivered.push(now);
          }
          // In every window (x - windowMs, x] that ends at a delivery, at most `limit` deliveries.
          for (const x of delivered) {
            const inWindow = delivered.filter((d) => d > x - windowMs && d <= x).length;
            expect(inWindow).toBeLessThanOrEqual(limit);
          }
          expect(t.delivered + t.dropped).toBe(gaps.length);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('counts every dropped rejection, so the audit trail can still record each one', () => {
    const t = createThrottle({ limit: 5, windowMs: 60_000 });
    for (let i = 0; i < 1000; i++) t.offer(1_000);
    expect(t.delivered).toBe(5);
    expect(t.dropped).toBe(995);
  });

  it('delivers again once the window has passed', () => {
    const t = createThrottle({ limit: 1, windowMs: 100 });
    expect(t.offer(0)).toBe('deliver');
    expect(t.offer(50)).toBe('drop');
    expect(t.offer(100)).toBe('deliver');
  });

  it('refuses parameters that cannot bound anything, and times that go backwards', () => {
    expect(() => createThrottle({ limit: -1, windowMs: 10 })).toThrow(RangeError);
    expect(() => createThrottle({ limit: 1.5, windowMs: 10 })).toThrow(RangeError);
    expect(() => createThrottle({ limit: 1, windowMs: 0 })).toThrow(RangeError);
    const t = createThrottle({ limit: 1, windowMs: 10 });
    t.offer(20);
    expect(() => t.offer(19)).toThrow(RangeError);
  });
});
