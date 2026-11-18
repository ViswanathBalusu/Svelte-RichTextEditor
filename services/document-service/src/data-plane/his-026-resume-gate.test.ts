/**
 * HIS-026, the resume place of the gate: a channel that resumes at a `seq` below the caller's gate is
 * answered with `catchUp: "reload"` and gets no commit from before the gate; at or above it the same
 * caller resumes by stream, so the suite fails when the gate is too strict as well as too lax. Each
 * setting (`editors`, `all`, `since_access`) and each role is run, with the gate written out by hand
 * (07 §8; 08 §9; ADR 0034). The other places are in test/control-plane/his-026-gate-negative.test.ts.
 * The real data plane runs over in-memory stores (test/data-plane/support.ts), as PRO-025 does.
 */
import type { DocRole } from '@docedit/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import {
  memoryStores,
  startPlane,
  type Plane,
  type Stores,
} from '../../test/data-plane/support.ts';
import type { DocumentStore } from '../storage/types.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const HEAD = 4;
const TIMES = [1_000, 2_000, 3_000, 4_000];

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** Stores whose documents report the given history setting (the memory store keeps `editors`). */
function withHistory(setting: string): Stores {
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
  return { ...s, documents };
}

type Setting = 'editors' | 'all' | 'since_access';
const ROLES: readonly DocRole[] = ['owner', 'editor', 'commenter', 'viewer'];

/** The gate by hand: `edit` roles see all under `editors`, everyone under `all`, the claim or the head. */
function gateOf(setting: Setting, role: DocRole, claim: boolean): number {
  if (setting === 'all') return 0;
  if (setting === 'editors') return role === 'owner' || role === 'editor' ? 0 : HEAD;
  return claim ? 3 : HEAD;
}

describe('resume below the gate reloads, at or above it streams (HIS-026)', () => {
  for (const setting of ['editors', 'all', 'since_access'] as Setting[]) {
    for (const role of ROLES) {
      for (const claim of setting === 'since_access' ? [true, false] : [false]) {
        const gate = gateOf(setting, role, claim);
        it(`${setting}, ${role}${setting === 'since_access' ? (claim ? ', with access_since' : ', without it') : ''} (gate ${gate})`, async () => {
          let now = 1_000;
          const p = await startPlane({ now: () => now, stores: withHistory(setting) });
          planes.push(p);
          const doc = await p.createDocument();
          const alice = await p.client('alice', { [doc]: 'owner' });
          const first = await alice.open(1, doc);
          const incarnation = first.d!['incarnation'] as string;
          for (const [i, t] of TIMES.entries()) {
            now = t;
            const r = await alice.submit(1, { base: i, steps: [insertText(intro(), `${i}`)] });
            expect(r.t).toBe('sync.ack');
          }
          // The claim is a moment after commit 3 and before commit 4: the gate is commit 3.
          const spec = claim ? { accessSince: 3_500 } : {};
          const reader = await p.client('frank', { [doc]: role }, spec);
          const opened = await reader.open(1, doc);
          const view = opened.d!['view'] as string;
          expect(opened.d).toMatchObject({ head: HEAD });
          reader.close();

          const wrong: string[] = [];
          for (let seq = 0; seq <= HEAD; seq++) {
            const again = await p.client('frank', { [doc]: role }, spec);
            const r = await again.open(1, doc, { resume: { seq, incarnation, view } });
            const expected = seq >= gate ? 'stream' : 'reload';
            if (r.d!['catchUp'] !== expected)
              wrong.push(`resume ${seq}: ${String(r.d!['catchUp'])} (wanted ${expected})`);
            // Nothing from before the gate is streamed to a channel that was refused the resume.
            if (expected === 'reload') {
              const sent = again.log
                .filter((m) => m.t === 'sync.commit')
                .flatMap((m) => m.d!['commits'] as Array<{ seq: number }>)
                .map((c) => c.seq);
              if (sent.some((s) => s <= seq)) wrong.push(`resume ${seq}: streamed ${sent}`);
            }
            again.close();
          }
          expect(wrong).toEqual([]);
        });
      }
    }
  }
});
