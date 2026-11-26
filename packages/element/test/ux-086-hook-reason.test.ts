// UX-086 criterion 2, the user's side: when the tenant's data-loss prevention hook refuses an
// export, the service answers 403 with the hook's reason as the problem detail, the REST port makes
// a PortError of it (packages/backend-dep/src/rest.ts), and the element hands that reason on:
// `requestExport` rejects with it, and the print path raises it as the `de-error` message. The
// exports port is a stand-in that refuses as the service does.
import type { Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { PortError } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { ErrorDetail } from '../src/events.ts';
import { startExport } from '../src/export.ts';
import { printTypesetPdf } from '../src/print.ts';

const REASON = 'The document is classified and may not leave the tenant.';

function refusing(): Backend {
  const port: ExportsPort = {
    async request() {
      throw new PortError('forbidden', REASON, {
        details: { code: 'forbidden', detail: REASON, status: 403 },
      });
    },
    async get() {
      return { id: 'job-1' } as unknown as ExportJob;
    },
    async cancel() {},
  };
  return { features: new Set(['exports']), exports: port } as unknown as Backend;
}

describe('the reason of a refused export reaches the user (UX-086 criterion 2)', () => {
  it('rejects requestExport with the hook reason', async () => {
    const source = { docId: 'doc-1', backend: refusing() };
    await expect(startExport(source, { target: 'pdf' } as never)).rejects.toMatchObject({
      code: 'forbidden',
      message: REASON,
    });
  });

  it('raises the hook reason as the de-error message and prints nothing', async () => {
    const errors: ErrorDetail[] = [];
    const printed: string[] = [];
    const outcome = await printTypesetPdf({
      source: { docId: 'doc-1', backend: refusing() },
      access: { restrictions: [] } as never,
      printPdf: async (url) => void printed.push(url),
      onError: (d) => errors.push(d),
    });
    expect(outcome).toMatchObject({ status: 'failed', code: 'forbidden', message: REASON });
    expect(errors).toEqual([{ code: 'forbidden', message: REASON, fatal: false }]);
    expect(printed).toEqual([]);
  });
});
