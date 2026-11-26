// UX-078 criterion 3: the picture upload carries the quota kind of a refusal to the engine, so that
// the shell can say which quota was reached. Node.js: the assets port is a fake that refuses.
import { PortError } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { pictureAssets } from '../src/assets.ts';

// A 1 by 1 PNG header is enough for the size reader.
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
]);

const refusing = (details?: Record<string, unknown>) =>
  pictureAssets(
    {
      upload: () => {
        throw new PortError('quota_exceeded', 'the storage quota is reached', {
          ...(details ? { details } : {}),
        });
      },
    } as never,
    'doc-1',
  );

describe('pictureAssets and a refused upload', () => {
  it('carries the quota the service named', async () => {
    const out = await refusing({ code: 'quota_exceeded', quota: 'storage' }).upload({
      bytes: PNG,
      mime: 'image/png',
      name: 'p.png',
    } as never);
    expect(out).toMatchObject({ ok: false, quota: 'storage' });
  });

  it('carries none when the service named none, or a kind it does not know', async () => {
    for (const details of [undefined, { quota: 'something-new' }]) {
      const out = await refusing(details).upload({
        bytes: PNG,
        mime: 'image/png',
        name: 'p.png',
      } as never);
      expect(out).toMatchObject({ ok: false });
      expect('quota' in out).toBe(false);
    }
  });
});

describe('an export request the service refused for a quota', () => {
  it('reaches the dialog as the port error that names the quota', async () => {
    const { startExport } = await import('../src/export.ts');
    const refusal = new PortError('quota_exceeded', 'the export minutes quota is reached', {
      details: { code: 'quota_exceeded', quota: 'exportMinutes' },
    });
    const backend = {
      features: new Set(['exports']),
      exports: {
        request: () => Promise.reject(refusal),
      },
    };
    await expect(
      startExport(
        { backend, docId: 'd1', access: null } as never,
        { target: 'pdf', options: {} } as never,
      ),
    ).rejects.toBe(refusal);
  });
});
