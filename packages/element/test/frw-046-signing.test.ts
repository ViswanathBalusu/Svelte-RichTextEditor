// The adoption and signing step's service over the core and the backend ports (FRW-045 criterion 2,
// FRW-046 criterion 1): activating a field the participant may sign is a request, the image goes
// through the assets port and the sign request through the fields port, and a refusal is said in a
// word. Node.js, stand-in ports.
import { DocumentCore } from '@docedit/engine/headless';
import type { EditorCore } from '@docedit/engine';
import { PortError, type AssetsPort, type FieldsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { signingService, signRefusal } from '../src/signing.ts';
import { participantAccess } from '../../engine/test/frw-fields-fixture.ts';
import { SIGN_LANDLORD, SIGN_TENANT, withSignatures } from '../../engine/test/frw-046-fixture.ts';

const schedule = (run: () => void): void => queueMicrotask(run);

interface Calls {
  uploads: Array<{ doc: string; filename: string; type: string; size: number }>;
  signs: Array<{ doc: string; field: string; body: unknown }>;
}

function setup(
  options: { upload?: () => Promise<{ asset: string }>; sign?: () => Promise<unknown> } = {},
) {
  const calls: Calls = { uploads: [], signs: [] };
  const assets: Pick<AssetsPort, 'upload'> = {
    upload: async (doc, file) => {
      calls.uploads.push({
        doc,
        filename: file.filename,
        type: file.source.type,
        size: file.source.size,
      });
      return options.upload ? options.upload() : { asset: `asset-${calls.uploads.length}` };
    },
  };
  const fields: Pick<FieldsPort, 'sign'> = {
    sign: async (doc, field, body) => {
      calls.signs.push({ doc, field, body });
      return (options.sign ? options.sign() : {}) as never;
    },
  };
  const core = new DocumentCore({
    doc: withSignatures(),
    mode: 'fill',
    access: participantAccess(['role_tenant']),
    schedule,
  });
  const service = signingService(core as unknown as EditorCore, () => ({
    assets,
    fields,
    docId: 'd1',
  }));
  return { core, service, calls };
}

const image = (): Blob =>
  new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

describe('activating a signature field is a request (FRW-046 criterion 1)', () => {
  it('follows the core: the field the participant may sign is the service request, and dismiss clears it', async () => {
    const { core, service } = setup();
    expect(service.request.get()).toBeNull();
    let heard = 0;
    service.request.subscribe(() => heard++);
    expect(core.requestSign(SIGN_TENANT)).toBe(true);
    expect(service.request.get()).toMatchObject({
      id: SIGN_TENANT,
      kind: 'signature',
      role: 'Tenant',
    });
    // The core tells its listeners after the change, as it does for every view.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toBe(1);
    // A field of another role makes no request.
    expect(core.requestSign(SIGN_LANDLORD)).toBe(false);
    service.dismiss();
    expect(service.request.get()).toBeNull();
  });
});

describe('the image goes through the assets port (FRW-045 criterion 2)', () => {
  it('uploads the image and keeps the adoption by kind', async () => {
    const { service, calls } = setup();
    expect(service.adopted('signature')).toBeNull();
    const out = await service.adopt('signature', 'typed', image(), 'signature-typed.png');
    expect(out).toEqual({ ok: true, adoption: { asset: 'asset-1', mode: 'typed' } });
    expect(calls.uploads).toEqual([
      { doc: 'd1', filename: 'signature-typed.png', type: 'image/png', size: 4 },
    ]);
    expect(service.adopted('signature')).toEqual({ asset: 'asset-1', mode: 'typed' });
    // The initials are adopted on their own.
    expect(service.adopted('initials')).toBeNull();
    await service.adopt('initials', 'drawn', image(), 'initials-drawn.png');
    expect(service.adopted('initials')).toEqual({ asset: 'asset-2', mode: 'drawn' });
    expect(service.adopted('signature')).toEqual({ asset: 'asset-1', mode: 'typed' });
  });

  it('says an image the asset worker refused is rejected, and any other failure failed', async () => {
    const refused = setup({
      upload: async () => {
        throw new PortError('validation_failed', 'asset a1 failed');
      },
    });
    expect(await refused.service.adopt('signature', 'uploaded', image(), 'x.png')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(refused.service.adopted('signature')).toBeNull();
    const down = setup({
      upload: async () => {
        throw new PortError('unavailable', 'no');
      },
    });
    expect(await down.service.adopt('signature', 'typed', image(), 'x.png')).toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});

describe('the sign request goes through the fields port (FRW-046 criterion 1)', () => {
  it('posts the adoption for the field, and nothing else', async () => {
    const { service, calls } = setup();
    const out = await service.sign(SIGN_TENANT, { asset: 'asset-9', mode: 'drawn' });
    expect(out).toEqual({ ok: true });
    expect(calls.signs).toEqual([
      { doc: 'd1', field: SIGN_TENANT, body: { asset: 'asset-9', mode: 'drawn' } },
    ]);
  });

  it('says why the server refused', async () => {
    const consent = setup({
      sign: async () => {
        throw new PortError('forbidden', 'the consent is not on record: no acceptance');
      },
    });
    expect(await consent.service.sign(SIGN_TENANT, { asset: 'a', mode: 'typed' })).toEqual({
      ok: false,
      reason: 'consent',
    });
    expect(signRefusal(new PortError('forbidden', 'the participant is not active now'))).toEqual({
      ok: false,
      reason: 'not_active',
    });
    expect(signRefusal(new PortError('forbidden', 'the field is hidden'))).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(signRefusal(new PortError('conflict', 'the workflow is correcting'))).toEqual({
      ok: false,
      reason: 'not_active',
    });
    expect(signRefusal(new PortError('conflict', 'the field is already signed'))).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(signRefusal(new Error('network'))).toEqual({ ok: false, reason: 'failed' });
  });

  it('answers failed when the session has no ports any more', async () => {
    const core = new DocumentCore({ doc: withSignatures(), mode: 'fill', schedule });
    const service = signingService(core as unknown as EditorCore, () => null);
    expect(await service.sign('f', { asset: 'a', mode: 'typed' })).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(await service.adopt('signature', 'typed', image(), 'x.png')).toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});
