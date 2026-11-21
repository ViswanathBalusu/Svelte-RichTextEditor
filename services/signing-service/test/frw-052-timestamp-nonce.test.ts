// The nonce of a time-stamp query must read as a positive DER INTEGER with no leading zero byte.
// With a random 8-byte nonce one query in 128 began with 0x00 or 0x80 and OpenSSL's authority
// refused it ("the data submitted has the wrong format"), so a seal failed now and then (found in a
// full run under load: frw-052-service.test.ts, 2 of 10 runs in parallel).
import { describe, expect, it } from 'vitest';
import { timestampNonce } from '../src/cms.ts';

describe('timestampNonce', () => {
  it('draws again when the first byte would give a leading zero, and clears the sign bit', () => {
    const draws = [
      Uint8Array.of(0x00, 1, 2, 3, 4, 5, 6, 7),
      Uint8Array.of(0x80, 1, 2, 3, 4, 5, 6, 7),
      Uint8Array.of(0xc5, 1, 2, 3, 4, 5, 6, 7),
    ];
    let n = 0;
    const nonce = timestampNonce(() => draws[n++]!);
    expect(n).toBe(3);
    expect(Array.from(nonce)).toEqual([0x45, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('gives 8 bytes whose first byte is 1 to 0x7f, whatever the random source gives', () => {
    for (let first = 0; first < 256; first++) {
      let toggle = 0;
      // The source gives `first` once and then a fixed good value: the loop must end.
      const nonce = timestampNonce(() =>
        Uint8Array.of(toggle++ === 0 ? first : 0x21, 9, 9, 9, 9, 9, 9, 9),
      );
      expect(nonce).toHaveLength(8);
      expect(nonce[0]).toBeGreaterThanOrEqual(1);
      expect(nonce[0]).toBeLessThanOrEqual(0x7f);
    }
  });
});
