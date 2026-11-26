// PRO-097 criterion 4: the imports port uploads the Word file as an asset, requests the import with
// the asset identifier, and follows the job to its end. Fakes for the assets port and the two
// import routes, and a clock that the test moves, so no real timer runs.
import { describe, expect, it } from 'vitest';
import { PortError, type ImportJob } from '@docedit/protocol';
import { createImportFlow, importState, IMPORT_POLL_MS } from '../src/import-flow.ts';

const FILE = {
  filename: 'in.docx',
  source: {
    size: 3,
    type: 'application/octet-stream',
    arrayBuffer: async () => new ArrayBuffer(3),
  },
};

function setup(states: ReadonlyArray<string | PortError>, firstState = 'queued') {
  const calls: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const clock = {
    set: (fn: () => void, ms: number) => {
      timers.set(next, { fn, ms });
      return next++;
    },
    clear: (key: number | null | undefined) => {
      if (key !== null && key !== undefined) timers.delete(key);
    },
  };
  let reads = 0;
  const job = (state: string): ImportJob => ({ id: 'j-1', state, warnings: [] }) as ImportJob;
  const flow = createImportFlow({
    clock,
    assets: {
      upload: async (docId, file) => {
        calls.push(`upload ${docId} ${file.filename}`);
        return { asset: 'a-1' };
      },
    },
    imports: {
      request: async (docId, body, opts) => {
        calls.push(`request ${docId} ${JSON.stringify(body)} ${opts?.idempotencyKey ?? '-'}`);
        return job(firstState);
      },
      get: async (id) => {
        calls.push(`get ${id}`);
        const s = states[Math.min(reads++, states.length - 1)]!;
        if (s instanceof PortError) throw s;
        return { value: job(s), etag: 'W/"1"' };
      },
    },
  });
  /** Runs the timer that waits, and lets the read it starts finish. */
  const tick = async (): Promise<void> => {
    const [key, t] = [...timers.entries()][0]!;
    timers.delete(key);
    t.fn();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { flow, calls, timers, tick };
}

describe('the import flow of the imports port (PRO-097 criterion 4)', () => {
  it('uploads the file, requests the import with the asset, and follows the job until it completes', async () => {
    const { flow, calls, timers, tick } = setup(['running', 'completed']);
    const seen: Array<string | undefined> = [];
    const done = flow.importFile('d-1', FILE, {
      idempotencyKey: 'k-1',
      onProgress: (j) => seen.push(importState(j)),
    });
    await Promise.resolve();
    for (let i = 0; i < 10 && timers.size === 0; i++) await Promise.resolve();
    expect(calls.slice(0, 2)).toEqual([
      'upload d-1 in.docx',
      'request d-1 {"asset":"a-1","format":"docx"} k-1',
    ]);
    expect([...timers.values()][0]?.ms).toBe(IMPORT_POLL_MS);
    await tick();
    await tick();
    const job = await done;
    expect(importState(job)).toBe('completed');
    expect(seen).toEqual(['queued', 'running', 'completed']);
    expect(calls.filter((c) => c.startsWith('get'))).toHaveLength(2);
    expect(timers.size).toBe(0);
  });

  it('resolves with a failed job, so that the caller reads its state', async () => {
    const { flow, timers, tick } = setup(['failed']);
    const done = flow.importFile('d-1', FILE);
    for (let i = 0; i < 10 && timers.size === 0; i++) await Promise.resolve();
    await tick();
    expect(importState(await done)).toBe('failed');
    expect(timers.size).toBe(0);
  });

  it('reads again after a failed read, and stops when the job is not found', async () => {
    const { flow, timers, tick } = setup([
      new PortError('unavailable', 'down'),
      new PortError('not_found', 'gone'),
    ]);
    const done = flow.importFile('d-1', FILE);
    const outcome = done.then(
      () => 'resolved',
      (e: unknown) => (e as PortError).code,
    );
    for (let i = 0; i < 10 && timers.size === 0; i++) await Promise.resolve();
    await tick();
    expect(timers.size).toBe(1);
    await tick();
    expect(await outcome).toBe('not_found');
    expect(timers.size).toBe(0);
  });

  it('resolves at once when the request already answers a finished job', async () => {
    const { flow, timers } = setup([], 'completed');
    const job = await flow.importFile('d-1', FILE);
    expect(importState(job)).toBe('completed');
    expect(timers.size).toBe(0);
  });

  it('rejects the import that still follows a job when the backend closes, and leaves no timer', async () => {
    const { flow, timers } = setup(['running']);
    const done = flow.importFile('d-1', FILE);
    const outcome = done.then(
      () => 'resolved',
      (e: unknown) => (e as PortError).message,
    );
    for (let i = 0; i < 10 && timers.size === 0; i++) await Promise.resolve();
    flow.abort('the backend was closed');
    expect(await outcome).toBe('the backend was closed');
    expect(timers.size).toBe(0);
  });

  it('does not request an import when the upload fails', async () => {
    const calls: string[] = [];
    const flow = createImportFlow({
      clock: { set: () => 1, clear: () => {} },
      assets: {
        upload: async () => {
          throw new PortError('unavailable', 'the upload answered 500');
        },
      },
      imports: {
        request: async () => {
          calls.push('request');
          return { id: 'x' };
        },
        get: async () => {
          throw new Error('not reached');
        },
      },
    });
    await expect(flow.importFile('d-1', FILE)).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toEqual([]);
  });
});
