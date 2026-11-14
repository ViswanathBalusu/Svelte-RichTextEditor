// FE-055 criterion 4 (print part): the print refusal reads the access object in force at each call,
// so a `no-print` restriction removed by `perm.changed` applies to the next print without a reload,
// and a restriction added applies at once. The copy part is in packages/engine/test/restrictions.test.ts.
import type { Access, Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { printTypesetPdf, type PrintOptions } from '../src/print.ts';

function exportsPort(): { port: ExportsPort; requests: number } {
  const state = { requests: 0 };
  const port: ExportsPort = {
    async request() {
      state.requests += 1;
      return { id: 'job-1' } as unknown as ExportJob;
    },
    async get() {
      return {
        id: 'job-1',
        state: 'completed',
        result: { url: 'https://x/y.pdf' },
      } as never;
    },
    async cancel() {},
  };
  return {
    port,
    get requests() {
      return state.requests;
    },
  } as { port: ExportsPort; requests: number };
}

function backend(port: ExportsPort): Backend {
  return { features: new Set(['exports']), exports: port } as unknown as Backend;
}

function access(restrictions: Access['restrictions']): Access {
  return { restrictions } as unknown as Access;
}

function options(acc: Access | null, printed: string[]): PrintOptions {
  return {
    source: { docId: 'doc-1', backend: backend(exportsPort().port) },
    access: acc,
    printPdf: async (url) => {
      printed.push(url);
    },
    onError: () => {
      throw new Error('a refusal must not raise an error');
    },
    pollMs: 1,
    wait: async () => {},
  };
}

describe('the no-print refusal follows the access object (FE-055 criterion 4)', () => {
  it('refuses while no-print is listed, then prints once the restriction is removed', async () => {
    const printed: string[] = [];
    const restricted = options(access(['no-print']), printed);
    await expect(printTypesetPdf(restricted)).resolves.toEqual({
      status: 'refused',
      reason: 'no-print',
    });
    expect(printed).toEqual([]);

    // The next print, with the access updated by perm.changed.
    const updated = options(access([]), printed);
    await expect(printTypesetPdf(updated)).resolves.toEqual({ status: 'printed' });
    expect(printed).toEqual(['https://x/y.pdf']);
  });

  it('refuses at once when no-print is added, and asks for no export', async () => {
    const printed: string[] = [];
    const counted = exportsPort();
    const open: PrintOptions = {
      ...options(access([]), printed),
      source: { docId: 'doc-1', backend: backend(counted.port) },
    };
    await expect(printTypesetPdf(open)).resolves.toEqual({ status: 'printed' });
    const requestsBefore = counted.requests;

    const closed: PrintOptions = { ...open, access: access(['no-print']) };
    await expect(printTypesetPdf(closed)).resolves.toEqual({
      status: 'refused',
      reason: 'no-print',
    });
    expect(counted.requests).toBe(requestsBefore);
    expect(printed).toEqual(['https://x/y.pdf']);
  });
});
