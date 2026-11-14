// PRO-072 criterion 2 over HTTP (lane V-PRO-069-085): a burst of content changes to one document
// raises one `dep.document.changed` at once, and the last change of the burst is raised when the
// ten-second window ends, so no state is lost. The running handlers emit through `createKit`, which
// now debounces the event (event-throttle.ts). Memory storage and PostgreSQL storage (the harness
// creates and drops its own database). The window is real time here: the trailing event waits up
// to ten seconds, so the test allows for it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const CHANGE = 'dep.document.changed.v1';

function edited(text: string): Record<string, unknown> {
  const env = structuredClone(documentWithRegions()) as Record<string, unknown>;
  const walk = (n: unknown): boolean => {
    if (n === null || typeof n !== 'object') return false;
    const o = n as Record<string, unknown>;
    if (typeof o['text'] === 'string') {
      o['text'] = text;
      return true;
    }
    return Object.values(o).some(walk);
  };
  walk(env['doc']);
  return env;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`dep.document.changed debounce in the running service (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'a burst of content changes raises one change at once and the last of the burst after the window (PRO-072 criterion 2)',
      async () => {
        const doc = await h.createDocument({
          content: documentWithRegions(),
          title: 'V-PRO-069-085 burst',
        });
        const etag = async () =>
          (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).headers.get(
            'etag',
          );
        for (let i = 0; i < 6; i += 1) {
          const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
            token: h.apiKey,
            body: edited(`V-PRO-069-085 burst ${i}`),
            headers: { 'If-Match': (await etag())! },
          });
          expect(put.status).toBe(204);
        }

        const changes = () => h.events.events.filter((e) => e.subject === doc && e.type === CHANGE);
        // The first change of the window is raised at once; the other five wait for the window.
        expect(changes()).toHaveLength(1);
        const first = changes()[0]!;
        expect(first.data['chainHead']).toMatch(/^[0-9a-f]{64}$/);

        // The last change of the burst is raised once the window has ended (real time, ten seconds).
        await new Promise<void>((resolve, reject) => {
          const started = Date.now();
          const poll = setInterval(() => {
            if (changes().length >= 2) {
              clearInterval(poll);
              resolve();
            } else if (Date.now() - started > 20_000) {
              clearInterval(poll);
              reject(
                new Error('the trailing dep.document.changed was not raised within 20 seconds'),
              );
            }
          }, 250);
        });
        expect(changes()).toHaveLength(2);
        const trailing = changes()[1]!;
        expect(trailing.data['seq']).toBeGreaterThan(first.data['seq'] as number);
        expect(trailing.data['chainHead']).toMatch(/^[0-9a-f]{64}$/);
      },
      30_000,
    );
  });
}
