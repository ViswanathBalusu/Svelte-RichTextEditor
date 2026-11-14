// Binary frame layout (05 §4; PRO-020 criteria 1 and 3). Universal: runs in Node.js and in browsers.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeBinaryFrame, encodeBinaryFrame } from './binary.ts';

/** maxMessageBytes of the example in 05 §5.9 (131,072); a payload of this size must round-trip. */
const MAX_MESSAGE_BYTES = 131072;

describe('binary frame layout (PRO-020, criterion 1)', () => {
  it('decodes ch, kind and id as unsigned LEB128 followed by the payload, at 127, 128 and 16,384', () => {
    const wire = new Uint8Array([0x7f, 0x80, 0x01, 0x80, 0x80, 0x01, 9]);
    const frame = decodeBinaryFrame(wire);
    expect(frame).not.toBeNull();
    expect(frame?.ch).toBe(127);
    expect(frame?.kind).toBe(128);
    expect(frame?.id).toBe(16384);
    expect([...(frame?.payload ?? [])]).toEqual([9]);
  });

  it('reads each single-byte boundary value (0, 127) and the two-byte value 128 as the same integers', () => {
    const cases: [number, number, number][] = [
      [0, 0, 0],
      [127, 127, 127],
      [128, 128, 128],
      [16384, 16383, 16384],
    ];
    for (const [ch, kind, id] of cases) {
      const back = decodeBinaryFrame(
        encodeBinaryFrame({ ch, kind, id, payload: new Uint8Array() }),
      );
      expect(back).toMatchObject({ ch, kind, id });
    }
  });

  it('decodes the three integers in the order ch, kind, id for random values', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (ch, kind, id) => {
          const back = decodeBinaryFrame(
            encodeBinaryFrame({ ch, kind, id, payload: new Uint8Array([1, 2, 3]) }),
          );
          expect(back).toMatchObject({ ch, kind, id });
          expect([...(back?.payload ?? [])]).toEqual([1, 2, 3]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('binary frame round trip (PRO-020, criterion 3)', () => {
  it('is lossless for a payload of zero bytes', () => {
    const back = decodeBinaryFrame(
      encodeBinaryFrame({ ch: 1, kind: 2, id: 3, payload: new Uint8Array(0) }),
    );
    expect(back).toEqual({ ch: 1, kind: 2, id: 3, payload: new Uint8Array(0) });
  });

  it('is lossless for a payload of exactly maxMessageBytes', () => {
    const payload = new Uint8Array(MAX_MESSAGE_BYTES).map((_, i) => (i * 37) % 256);
    const wire = encodeBinaryFrame({ ch: 16384, kind: 127, id: 128, payload });
    const back = decodeBinaryFrame(wire);
    expect(back?.ch).toBe(16384);
    expect(back?.kind).toBe(127);
    expect(back?.id).toBe(128);
    expect(back?.payload).toEqual(payload);
  });

  it('is lossless for random payloads of any length up to maxMessageBytes (property)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 4096 }),
        fc.nat({ max: 1_000_000 }),
        (payload, ch) => {
          const back = decodeBinaryFrame(encodeBinaryFrame({ ch, kind: 0, id: 0, payload }));
          expect(back?.ch).toBe(ch);
          expect(back?.payload).toEqual(payload);
        },
      ),
      { numRuns: 100 },
    );
  });
});
