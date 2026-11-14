// BE-043 criterion 3 over the control plane, on both storages (lane V-BE-043-056, round 3): a valid
// image is decoded and re-encoded by the asset worker, the SHA-256 of the bytes it stores is the
// row's hash, and the row holds the facts of the stored object. The PostgreSQL block runs against the
// test database of infra/test-env.ps1 and skips when it is not up. The memory block is the same
// check as be-043-reencode.test.ts and keeps this file self-contained.
import { createHash } from 'node:crypto';
import { unsandboxed } from '@docedit/asset-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The IHDR chunk ends after the signature (8 bytes), its length (4), type (4), data (13) and CRC (4). */
const IHDR_END = 8 + 4 + 4 + 13 + 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk with its length and CRC. */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** The same image with a textual chunk after IHDR. */
const WITH_TEXT = Buffer.concat([
  PNG.subarray(0, IHDR_END),
  chunk('tEXt', Buffer.from('Comment\0uploaded with a note the worker must drop')),
  PNG.subarray(IHDR_END),
]);

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`BE-043 criterion 3 over the control plane (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        views: FULL_VIEWS,
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        config: { jobIdleMs: 20 },
      });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      're-encodes a valid image, hashes the bytes it stores, and marks the row ready with their facts',
      async () => {
        // The test PNG carries the textual chunk; the check below depends on it.
        expect(WITH_TEXT.includes(Buffer.from('tEXt', 'latin1'))).toBe(true);
        expect(WITH_TEXT.length).toBeGreaterThan(PNG.length);

        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
          token: editor,
          body: { filename: 'dot.png', mime: 'image/png', size: WITH_TEXT.length },
        });
        expect(r.status).toBe(201);
        const id = r.json.asset as string;
        await h.service.assets.putQuarantined(h.tenant, id, WITH_TEXT);
        expect((await h.call('POST', `/v1/assets/${id}/complete`, { token: editor })).status).toBe(
          202,
        );

        let row = await h.parts.assetRegistry.get(h.tenant, id);
        for (let i = 0; i < 200 && row?.state !== 'ready' && row?.state !== 'failed'; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          row = await h.parts.assetRegistry.get(h.tenant, id);
        }
        expect(row).toMatchObject({
          state: 'ready',
          contentType: 'image/png',
          width: 1,
          height: 1,
        });
        expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(row!.objectKey).toBe(`tenants/${h.tenant}/assets/${row!.sha256}`);

        // The stored object is the worker's output: it exists under the key, its size and hash are the
        // row's, and it is a PNG without the chunk the upload carried (decoded and re-encoded).
        const stored = await h.parts.objects.get(row!.objectKey!);
        expect(stored).not.toBeNull();
        const bytes = Buffer.from(stored!);
        expect(bytes.length).toBe(row!.bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(row!.sha256);
        expect(bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)).toBe(true);
        expect(bytes.includes(Buffer.from('tEXt', 'latin1'))).toBe(false);
        expect(bytes.includes(Buffer.from('uploaded with a note', 'latin1'))).toBe(false);
        // The quarantined upload is gone.
        expect(await h.service.assets.getQuarantined(h.tenant, id)).toBeNull();
      },
    );
  });
}
