/**
 * The shell's region list and grants service over the permissions port (PRO-080 criterion 2), with
 * the in-memory backend's document behind the port.
 */
import { describe, expect, it } from 'vitest';
import type { RegionGrant } from '@docedit/ui';
import { grantsService, regionsView } from './permissions-shell.ts';
import type { ReadView } from './session.ts';

function signal(): ReadView<number> & { fire(): void } {
  const listeners = new Set<() => void>();
  let n = 0;
  return {
    get: () => n,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire() {
      n += 1;
      for (const l of [...listeners]) l();
    },
  };
}

const region = (id: string, title: string) =>
  ({ id, title, policy: 'inherit', order: 0, state: 'draft' }) as const;

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('regionsView', () => {
  it('reads the list when first watched and again when the access changes', async () => {
    const asked: string[] = [];
    let list = [region('r1', 'Middle')];
    const access = signal();
    const view = regionsView(
      async (docId) => {
        asked.push(docId);
        return list;
      },
      'doc-1',
      [access],
    );
    expect(view.get()).toEqual([]);
    expect(asked).toEqual([]);

    let notified = 0;
    const stop = view.subscribe(() => (notified += 1));
    await settle();
    expect(asked).toEqual(['doc-1']);
    expect(view.get().map((r) => r.title)).toEqual(['Middle']);
    expect(notified).toBe(1);

    list = [region('r1', 'Middle'), region('r2', 'End')];
    access.fire();
    await settle();
    expect(view.get().map((r) => r.title)).toEqual(['Middle', 'End']);
    expect(notified).toBe(2);

    stop();
    access.fire();
    await settle();
    expect(asked).toHaveLength(2);
  });

  it('keeps the last list when a read fails, and never lets an older answer win', async () => {
    const access = signal();
    const answers: Array<(list: ReturnType<typeof region>[] | Error) => void> = [];
    const view = regionsView(
      () =>
        new Promise((resolve, reject) =>
          answers.push((a) => (a instanceof Error ? reject(a) : resolve(a))),
        ),
      'doc-1',
      [access],
    );
    view.subscribe(() => {});
    access.fire();
    // The second read answers first; the first, older answer is then ignored.
    answers[1]!([region('r2', 'Newer')]);
    await settle();
    answers[0]!([region('r1', 'Older')]);
    await settle();
    expect(view.get().map((r) => r.title)).toEqual(['Newer']);

    access.fire();
    answers[2]!(new Error('unavailable'));
    await settle();
    expect(view.get().map((r) => r.title)).toEqual(['Newer']);
  });
});

describe('grantsService', () => {
  it('loads the grants with their ETag and saves with If-Match', async () => {
    let rev = 1;
    let stored: RegionGrant[] = [];
    const calls: unknown[] = [];
    const service = grantsService(
      {
        grants: async (docId) => {
          calls.push(['grants', docId]);
          return { value: { rev, grants: stored }, etag: `"g${rev}"` };
        },
        updateGrants: async (docId, patch, opts) => {
          calls.push(['updateGrants', docId, opts.ifMatch]);
          if (opts.ifMatch !== `"g${rev}"`)
            throw Object.assign(new Error('changed'), { code: 'precondition_failed' });
          stored = patch.grants ?? stored;
          rev += 1;
          return { value: { rev, grants: stored }, etag: `"g${rev}"` };
        },
      },
      'doc-1',
    );

    const first = await service.load();
    expect(first).toEqual({ etag: '"g1"', grants: [] });
    const grant: RegionGrant = { region: 'r1', principal: 'user:bob', role: 'editor' };
    const saved = await service.save([grant], first.etag);
    expect(saved).toEqual({ etag: '"g2"', grants: [grant] });
    // The old ETag is refused with the code the pane reloads on; nothing is overwritten.
    await expect(service.save([], first.etag)).rejects.toMatchObject({
      code: 'precondition_failed',
    });
    expect(stored).toEqual([grant]);
    expect(calls).toEqual([
      ['grants', 'doc-1'],
      ['updateGrants', 'doc-1', '"g1"'],
      ['updateGrants', 'doc-1', '"g1"'],
    ]);
  });
});
