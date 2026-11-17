/**
 * FND-005 criterion 3, second half (01 §8; lane w5): Zstandard is how checkpoints and commit
 * payloads are stored, and it is not the encoding of an HTTP answer. The service sends content as
 * plain JSON and sets no `Content-Encoding` of its own, whatever the client offers, so the encoding
 * on the wire is left to the normal negotiation of whatever stands in front of it (a proxy or a
 * gateway). The stored form is checked in `test/postgres/write-path.pg.test.ts` (payloads) and
 * `test/data-plane/be-020-checkpoint-object.pg.test.ts` (checkpoints).
 *
 * Runs the real service over HTTP with memory storage. The request is made with `node:http`,
 * because `fetch` decodes a body by itself and hides the header.
 */
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeContent } from '../../src/storage/codec.ts';
import { startHarness, type Harness } from './support.ts';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** The Zstandard frame magic number (RFC 8878 §3.1.1), little-endian `0xFD2FB528`. */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function get(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP answers are not Zstandard-encoded by the service (FND-005 criterion 3)', () => {
  it('stores content as a Zstandard frame', () => {
    const stored = encodeContent('{"doc":{"type":"doc"}}');
    expect([...stored.subarray(0, 4)]).toEqual(MAGIC);
  });

  for (const offered of ['identity', 'zstd', 'zstd, gzip, br']) {
    it(`answers content as plain JSON with no Content-Encoding when the client offers ${offered}`, async () => {
      const h = await startHarness('memory');
      harnesses.push(h);
      const doc = await h.createDocument({});
      const res = await get(`${h.base}/v1/documents/${doc}/content`, {
        Authorization: `Bearer ${h.apiKey}`,
        'Accept-Encoding': offered,
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect([...res.body.subarray(0, 4)]).not.toEqual(MAGIC);
      const json = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
      expect(json['seq']).toBe(0);
      expect(json['doc']).toBeDefined();
    });
  }
});
