/**
 * EXP-073 criterion 2 (Node.js only): the digest of the curated TeX Live image is recorded in the
 * bundle's `manifest.json` when a bundle is built. The image itself is not built here; the digest
 * is an input the caller (the export worker) supplies. Documents come from `test/docs.ts`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { doc, para, run } from '../test/docs.ts';

const DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;

const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);

describe('EXP-073 criterion 2: the image digest is recorded in manifest.json', () => {
  it('writes the given digest into manifest.json and into the manifest object', async () => {
    const bundle = await run(doc([para('Text.')]), { imageDigest: DIGEST });
    const parsed = JSON.parse(bundle.files['manifest.json']!) as { imageDigest: unknown };
    expect(parsed.imageDigest).toBe(DIGEST);
    expect(bundle.manifest.imageDigest).toBe(DIGEST);
  });

  it('records null when the caller gives no digest, so the field is always present', async () => {
    const bundle = await run(doc([para('Text.')]));
    const parsed = JSON.parse(bundle.files['manifest.json']!) as Record<string, unknown>;
    expect('imageDigest' in parsed).toBe(true);
    expect(parsed['imageDigest']).toBeNull();
  });

  it('records any well-formed digest exactly as given', () => {
    fc.assert(
      fc.asyncProperty(hex64, async (h) => {
        const digest = `sha256:${h}`;
        const bundle = await run(doc([para('Text.')]), { imageDigest: digest });
        const parsed = JSON.parse(bundle.files['manifest.json']!) as { imageDigest: unknown };
        expect(parsed.imageDigest).toBe(digest);
      }),
      { numRuns: 25 },
    );
  });

  it('leaves the content hashes and bundleHash unchanged: the digest is not a content file', async () => {
    const env = doc([para('Text.')]);
    const without = await run(structuredClone(env));
    const withDigest = await run(structuredClone(env), { imageDigest: DIGEST });
    expect(withDigest.files['main.tex']).toBe(without.files['main.tex']);
    expect(withDigest.files['styles.tex']).toBe(without.files['styles.tex']);
    expect(withDigest.files['map.json']).toBe(without.files['map.json']);
    expect(withDigest.manifest.files).toEqual(without.manifest.files);
    expect(withDigest.manifest.bundleHash).toBe(without.manifest.bundleHash);
  });

  it('refuses a malformed digest with a RangeError before any file is built', async () => {
    const bad = [
      '',
      'sha256:',
      DIGEST.slice('sha256:'.length),
      `SHA256:${'0'.repeat(64)}`,
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'0'.repeat(63)}`,
      `sha256:${'0'.repeat(65)}`,
      `sha256:${'g'.repeat(64)}`,
      `sha256:${'0'.repeat(64)}\n`,
      `md5:${'0'.repeat(32)}`,
    ];
    for (const digest of bad) {
      await expect(run(doc([para('Text.')]), { imageDigest: digest })).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });

  it('refuses every digest whose hex part is not exactly 64 lowercase digits (property)', async () => {
    const notHex64 = fc.oneof(
      fc.stringMatching(/^[0-9a-f]{0,63}$/),
      fc.stringMatching(/^[0-9a-f]{65,80}$/),
    );
    await fc.assert(
      fc.asyncProperty(notHex64, async (h) => {
        await expect(
          run(doc([para('Text.')]), { imageDigest: `sha256:${h}` }),
        ).rejects.toBeInstanceOf(RangeError);
      }),
      { numRuns: 25 },
    );
  });
});
