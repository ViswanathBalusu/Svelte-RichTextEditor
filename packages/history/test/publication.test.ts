// Publishing the chain head to the host (08 §12; 05 §7; HIS-034 criteria 1, 2 and 4): the webhook
// carries the seq and the head, at most one per 10 seconds per document, the window's end publishes
// the latest durable head, and a tentative head is never published.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HeadPublisher, PUBLISH_INTERVAL_MS } from '../src/publication.ts';

const T0 = 1_790_000_000_000;
const head = (seq: number, durable = true) => ({
  seq,
  chainHead: `h${seq}`,
  durable,
});

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

describe('the changed webhook carries the seq and the head, debounced (HIS-034 criterion 1)', () => {
  it('publishes the first durable head at once, with its seq and chain head', () => {
    const p = new HeadPublisher();
    const r = must(p.observe(T0, head(4)));
    expect(r.publish).toEqual({ seq: 4, chainHead: 'h4', at: T0 });
    expect(r.nextAt).toBeNull();
  });

  it('holds a head that arrives within 10 seconds of the last publication, and says when it is due', () => {
    const p = new HeadPublisher();
    must(p.observe(T0, head(4)));
    const r = must(p.observe(T0 + 3_000, head(5)));
    expect(r.publish).toBeNull();
    expect(r.nextAt).toBe(T0 + PUBLISH_INTERVAL_MS);
  });

  it('never publishes two heads closer than the window, whatever the arrival times (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ gap: fc.integer({ min: 0, max: 25_000 }), durable: fc.boolean() }), {
          minLength: 1,
          maxLength: 60,
        }),
        (steps) => {
          const p = new HeadPublisher();
          let now = T0;
          let seq = 0;
          const times: number[] = [];
          const seqs: number[] = [];
          for (const s of steps) {
            now += s.gap;
            seq += 1;
            const r = must(p.observe(now, head(seq, s.durable)));
            if (r.publish) {
              times.push(r.publish.at);
              seqs.push(r.publish.seq);
            }
          }
          for (let i = 1; i < times.length; i++) {
            expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(PUBLISH_INTERVAL_MS);
            expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
          }
        },
      ),
    );
  });
});

describe('the window end publishes the latest durable head (HIS-034 criterion 2)', () => {
  it('publishes the head that waited, when the window ends, even if nothing else changes', () => {
    const p = new HeadPublisher();
    must(p.observe(T0, head(1)));
    must(p.observe(T0 + 1_000, head(2)));
    const late = must(p.observe(T0 + 2_000, head(3)));
    expect(late.publish).toBeNull();
    expect(must(p.poll(T0 + PUBLISH_INTERVAL_MS - 1)).publish).toBeNull();
    expect(must(p.poll(T0 + PUBLISH_INTERVAL_MS))).toMatchObject({
      publish: { seq: 3, chainHead: 'h3', at: T0 + PUBLISH_INTERVAL_MS },
      nextAt: null,
    });
    // Nothing is left unannounced: a later poll publishes nothing more.
    expect(must(p.poll(T0 + 60_000)).publish).toBeNull();
  });

  it('leaves no changed state unannounced after a burst (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ gap: fc.integer({ min: 0, max: 4_000 }), durable: fc.boolean() }), {
          minLength: 1,
          maxLength: 60,
        }),
        (steps) => {
          const p = new HeadPublisher();
          let now = T0;
          let seq = 0;
          let lastDurable = 0;
          for (const s of steps) {
            now += s.gap;
            seq += 1;
            must(p.observe(now, head(seq, s.durable)));
            if (s.durable) lastDurable = seq;
          }
          // The window ends after the last change: the final publication carries the last durable head.
          const end = must(p.poll(now + PUBLISH_INTERVAL_MS));
          const published = end.publish?.seq ?? p.lastPublished?.seq ?? 0;
          expect(published).toBe(lastDurable);
        },
      ),
    );
  });
});

describe('a tentative head is never published (HIS-034 criterion 4)', () => {
  it('ignores a head that is not durable, and publishes only the durable one', () => {
    const p = new HeadPublisher();
    must(p.observe(T0, head(1)));
    const tentative = must(p.observe(T0 + 1_000, head(2, false)));
    expect(tentative.publish).toBeNull();
    expect(must(p.poll(T0 + 60_000)).publish).toBeNull();
    expect(p.lastPublished?.seq).toBe(1);
  });

  it('publishes a durable head only, never one above a tentative one that was not made durable', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }), (durability) => {
        const p = new HeadPublisher();
        let now = T0;
        const durableSeqs = new Set<number>();
        durability.forEach((d, i) => {
          now += 2_000;
          const seq = i + 1;
          if (d) durableSeqs.add(seq);
          must(p.observe(now, head(seq, d)));
        });
        const end = must(p.poll(now + PUBLISH_INTERVAL_MS * 2));
        const pubs = [p.lastPublished?.seq ?? 0, end.publish?.seq ?? 0];
        for (const seq of pubs) if (seq !== 0) expect(durableSeqs.has(seq)).toBe(true);
      }),
    );
  });
});

describe('the publisher refuses what it cannot judge', () => {
  it('refuses a time that moves backwards, changing nothing', () => {
    const p = new HeadPublisher();
    must(p.observe(T0 + 5_000, head(1)));
    expect(p.observe(T0, head(2))).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(p.lastPublished?.seq).toBe(1);
  });

  it('refuses a head that does not name a commit', () => {
    const p = new HeadPublisher();
    expect(p.observe(T0, head(0))).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(p.observe(1.5, head(1))).toMatchObject({ ok: false, code: 'validation_failed' });
  });
});
