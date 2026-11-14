// Negative sweep over the user-readable GET routes of 05 section 6 (BE-098 criterion 3; lane
// V-BE-085-098). Every such route, taken from the protocol definition (DEP1.operations), is called
// with a token that has no access to the document: it must refuse (4xx), never answer 2xx. A
// reader who is restricted from one region must never see that region's text in any answer. The
// owner gets 2xx on the core reads so the sweep is not vacuous. Runs over real HTTP against the
// in-process service, with in-memory storage and with PostgreSQL (Podman).
//
// Bare identifiers (`/threads/{tid}`, `/exports/{jid}`, `/imports/{jid}`) are sent with a random
// identifier here: the stranger is refused as not found. Refusal of real threads and jobs is
// covered by the route tests of EXP and PRO, not by this sweep.
import { DEP1 } from '@docedit/protocol';
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
/** The text of the legal region in `documentWithRegions` (the hidden content). */
const HIDDEN_TEXT = 'Liability';

/** The legal region is hidden from everyone but owners (the policy shape of be-098-field-projection). */
const visibility: Visibility = (conn) =>
  conn.role === 'owner'
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

/**
 * GET routes a user credential may call (05 §6.2). Service-only routes are not reads by a user.
 * `/fonts` is the tenant-wide font manifest, not a read of a document, so it is outside the sweep.
 */
const readRoutes = DEP1.operations.filter(
  (op) =>
    op.method === 'GET' &&
    op.base !== 'endpoint' &&
    op.security.includes('user') &&
    op.path !== '/fonts',
);

/** The path with `{id}` set to the document and every other parameter a fresh identifier. */
function pathFor(template: string, doc: string): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => (name === 'id' ? doc : uuid7()));
}

/**
 * A refusal that tells a restricted reader to reload (ADR 0019): 503 with the problem code
 * `unavailable` and `Retry-After: 0`, as `GET /documents/{id}/commits` answers a reader whose view
 * hides content. It carries no content, so it is a valid projection answer, not a server fault.
 */
function isReloadRefusal(r: { status: number; headers: Headers; text: string }): boolean {
  if (r.status !== 503 || r.headers.get('Retry-After') !== '0') return false;
  try {
    return (
      (JSON.parse(r.text) as { code?: unknown }).code === 'unavailable' &&
      !r.text.includes(HIDDEN_TEXT)
    );
  } catch {
    return false;
  }
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`read routes outside a room refuse or project for a reader without access (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    let other: string;

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { views: { ...FULL_VIEWS, visibility } });
      doc = await h.createDocument({ content: documentWithRegions() });
      other = await h.createDocument({ content: documentWithRegions() });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('sweeps every user-readable GET route of 05 section 6', () => {
      expect(readRoutes.length).toBeGreaterThanOrEqual(15);
    });

    it.skipIf(skip)(
      'serves the owner the core reads of a document (sanity for the sweep)',
      async () => {
        const owner = h.userToken({ [doc]: 'owner' });
        for (const template of [
          '/documents/{id}',
          '/documents/{id}/content',
          '/documents/{id}/regions',
          '/documents/{id}/grants',
        ]) {
          const r = await h.call('GET', `/v1${pathFor(template, doc)}`, { token: owner });
          expect(r.status, template).toBe(200);
        }
      },
    );

    it.skipIf(skip)('refuses a call with no credential on every read route', async () => {
      for (const op of readRoutes) {
        const r = await h.call('GET', `/v1${pathFor(op.path, doc)}`);
        expect(r.status, `${op.method} ${op.path}`).toBeGreaterThanOrEqual(400);
        expect(r.status, `${op.method} ${op.path}`).toBeLessThan(500);
        expect(r.text).not.toContain(HIDDEN_TEXT);
      }
    });

    it.skipIf(skip)(
      'refuses a stranger with no access to the document on every read route',
      async () => {
        const stranger = h.userToken({ [other]: 'editor' });
        for (const op of readRoutes) {
          const r = await h.call('GET', `/v1${pathFor(op.path, doc)}`, { token: stranger });
          expect(r.status, `${op.method} ${op.path}`).toBeGreaterThanOrEqual(400);
          expect(r.status, `${op.method} ${op.path}`).toBeLessThan(500);
          expect(r.text).not.toContain(HIDDEN_TEXT);
        }
      },
    );

    it.skipIf(skip)(
      'projects every read route for a reader restricted from one region',
      async () => {
        const reader = h.userToken({ [doc]: 'editor' });
        for (const op of readRoutes) {
          const r = await h.call('GET', `/v1${pathFor(op.path, doc)}`, { token: reader });
          if (isReloadRefusal(r)) continue;
          expect(r.status, `${op.method} ${op.path}`).toBeLessThan(500);
          if (r.status < 300) {
            expect(r.text, `${op.method} ${op.path} leaks hidden text`).not.toContain(HIDDEN_TEXT);
          }
        }
      },
    );

    it.skipIf(skip)(
      'tells a restricted reader of the commit log to reload, without content',
      async () => {
        const reader = h.userToken({ [doc]: 'editor' });
        const r = await h.call('GET', `/v1/documents/${doc}/commits?after=0`, { token: reader });
        expect(r.text).not.toContain(HIDDEN_TEXT);
        expect(isReloadRefusal(r), `${r.status} ${r.text}`).toBe(true);
      },
    );
  });
}
