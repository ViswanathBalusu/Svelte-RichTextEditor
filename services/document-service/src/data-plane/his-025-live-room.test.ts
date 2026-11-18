/**
 * HIS-025 criterion 5, the live room: a room that is already open takes the history visibility
 * setting stored now, so a change applies to the next channel and not only to a room opened later
 * (ADR 0034 section 2). The document store answers with a setting the test changes between two
 * resumes of the same viewer at the same `seq` of the same open room. The real data plane runs over
 * in-memory stores (test/data-plane/support.ts), as his-026-resume-gate.test.ts does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { memoryStores, startPlane, type Plane } from '../../test/data-plane/support.ts';
import type { DocumentStore } from '../storage/types.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('a change of the setting reaches a room that is open (HIS-025 criterion 5)', () => {
  it('a viewer who resumes below the head reloads under editors and streams once it is all, and back', async () => {
    let setting = 'editors';
    const s = memoryStores();
    const inner = s.memory;
    const documents = new Proxy(inner, {
      get(target, key) {
        if (key === 'get')
          return async (...args: Parameters<DocumentStore['get']>) => {
            const r = await target.get(...args);
            return r && { ...r, historyVisibility: setting };
          };
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as DocumentStore;
    const p = await startPlane({ stores: { ...s, documents } });
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const first = await alice.open(1, doc);
    const incarnation = first.d!['incarnation'] as string;
    for (let i = 0; i < 3; i++) {
      const r = await alice.submit(1, { base: i, steps: [insertText(intro(), `${i}`)] });
      expect(r.t).toBe('sync.ack');
    }

    const viewer = await p.client('frank', { [doc]: 'viewer' });
    const opened = await viewer.open(1, doc);
    const view = opened.d!['view'] as string;
    viewer.close();

    const resumeAt1 = async (): Promise<unknown> => {
      const again = await p.client('frank', { [doc]: 'viewer' });
      const r = await again.open(1, doc, { resume: { seq: 1, incarnation, view } });
      again.close();
      return r.d!['catchUp'];
    };

    expect(await resumeAt1()).toBe('reload');
    setting = 'all';
    expect(await resumeAt1()).toBe('stream');
    setting = 'editors';
    expect(await resumeAt1()).toBe('reload');
  });
});
