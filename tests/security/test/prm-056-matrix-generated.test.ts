/**
 * PRM-056 criteria 3 and 5 (07 §12): the guards read the authorisation matrix, and the matrix's
 * rows are tested from one table against the real service. Lane U-PRM-052-067.
 *
 * - Criterion 3, the static part: every guard call in the document service's control plane names a
 *   row id of `MATRIX`, and no call passes a capability list of its own (the `requireRow` call
 *   takes a row id; the removed `requireSomewhere` carried its own list).
 * - Criterion 5: for each row the service serves over HTTP, a case is generated for every document
 *   role, for a token with no role on the document (`outsider`) and for the service credential. A
 *   role that holds the row's capability must not be refused by the guard; a role that lacks it must
 *   get 403 `forbidden`. The expectation is the role table (`ROLE_CAPABILITIES`, 07 §2) and the
 *   row's requirement in `MATRIX`, not the guard's own code.
 *
 * Lane w4 (2026-11-15) added rows 3 (a commit over the wire), 4 and 5 (threads), 8 (a named
 * version) and 11 (a lease on a region that inherits, so the document role decides).
 *
 * Lane w9 (2026-11-25) added row 9 (a region restore, a dry run), now that HIS-018 is built; every
 * row of the matrix is generated here.
 *
 * Memory and PostgreSQL. Each case uses the shared harness; the document is created once per storage.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOC_ROLES,
  MATRIX,
  ROLE_CAPABILITIES,
  type Capability,
  type DocRole,
} from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  insertText,
  posInside,
  postgresUnavailable,
  startHarness,
  type CallResult,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const CONTROL_PLANE = fileURLToPath(
  new URL('../../../services/document-service/src/control-plane/', import.meta.url),
);

// --- Criterion 3: the guard calls name matrix rows. -------------------------------------------------

describe('PRM-056 criterion 3: guards read the matrix and carry no requirement of their own', () => {
  const rowIds = new Set(MATRIX.map((r) => r.id));
  const sources = readdirSync(CONTROL_PLANE)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => ({ f, text: readFileSync(CONTROL_PLANE + f, 'utf8') }));

  it('every guard or requireRow call in the control plane names a row of MATRIX', () => {
    const named: { file: string; id: string }[] = [];
    const call = /\b(?:guard|requireRow)\(\s*ctx\.caller,\s*([^,]+),/g;
    for (const { f, text } of sources) {
      for (const m of text.matchAll(call)) {
        // The row argument may be a ternary of two literals (`read.head` or `read.history`).
        for (const lit of m[1]!.matchAll(/'([a-z][a-z.]*)'/g)) named.push({ file: f, id: lit[1]! });
      }
    }
    expect(named.length).toBeGreaterThan(0);
    const unknown = named.filter((n) => !rowIds.has(n.id));
    expect(unknown).toEqual([]);
  });

  it('no control-plane file keeps a capability list of its own for a guard', () => {
    // A requirement written as a list of capabilities in a handler is the copy the matrix replaces.
    const copies = sources.flatMap(({ f, text }) =>
      text
        .split('\n')
        .flatMap((line, i) =>
          /\[\s*'(?:view|comment|suggest|edit|fill|manage|structure)'\s*,/.test(line) &&
          /(requireSomewhere|requireRow|requireCapability|guard)\(/.test(text)
            ? [`${f}:${i + 1}`]
            : [],
        ),
    );
    expect(copies).toEqual([]);
  });
});

// --- Criterion 5: generated cases per role over the wire. -------------------------------------------

type Who = DocRole | 'outsider' | 'service';
const WHO: readonly Who[] = [...DOC_ROLES, 'outsider', 'service'];

/** Whether `who` holds `cap` on the document (07 §2); the service credential passes every row. */
function holds(who: Who, cap: Capability): boolean {
  if (who === 'service') return true;
  if (who === 'outsider') return false;
  return ROLE_CAPABILITIES[who].includes(cap);
}

interface Case {
  /** The matrix row the case is generated from. */
  row: string;
  /** Whether `who` meets the row's requirement. */
  allowed: (who: Who) => boolean;
  /** The call, with the document identifier; `owner` is an owner's token for what a case sets up. */
  call: (doc: string, token: string, h: Harness, owner: string) => Promise<CallResult>;
  /**
   * The route names no document, so a caller with no role on the thread's document is refused
   * with 404 `not_found`, which does not say that the thread exists.
   */
  hiddenFromOutsider?: true;
  /** The positive case must succeed (2xx), not only pass the guard. */
  succeeds?: true;
}

const THREAD = {
  target: { block: 'pIntro0000000001' },
  comment: { body: [{ type: 'text', text: 'PRM-056.' }] },
};
const OPEN_REGION = 'rOpen00000000001';

const ROWS: readonly Case[] = [
  {
    row: 'read.head',
    allowed: (w) => holds(w, 'view'),
    call: (doc, token, h) => h.call('GET', `/v1/documents/${doc}/content`, { token }),
  },
  {
    row: 'read.history',
    allowed: (w) => holds(w, 'view'),
    call: (doc, token, h) => h.call('GET', `/v1/documents/${doc}/content?seq=0`, { token }),
  },
  {
    row: 'asset.upload',
    allowed: (w) => holds(w, 'edit') || holds(w, 'suggest') || holds(w, 'fill'),
    call: (doc, token, h) =>
      h.call('POST', `/v1/documents/${doc}/assets`, {
        token,
        body: { filename: 'prm-056.png', mime: 'image/png', size: 10 },
      }),
  },
  {
    row: 'asset.read',
    allowed: (w) => holds(w, 'view'),
    call: (doc, token, h) =>
      h.call('POST', `/v1/documents/${doc}/assets/resolve`, { token, body: { assets: [] } }),
  },
  {
    // Row 4. A thread has an author, so the service credential, which has none, is refused.
    row: 'thread.create',
    succeeds: true,
    allowed: (w) => w !== 'service' && holds(w, 'comment'),
    call: (doc, token, h) =>
      h.call('POST', `/v1/documents/${doc}/threads`, { token, body: THREAD }),
  },
  {
    // Row 5. The thread is the owner's; the caller resolves it.
    row: 'thread.update',
    hiddenFromOutsider: true,
    succeeds: true,
    allowed: (w) => holds(w, 'comment'),
    call: async (doc, token, h, owner) => {
      const made = await h.call('POST', `/v1/documents/${doc}/threads`, {
        token: owner,
        body: THREAD,
      });
      expect(made.status, made.text).toBe(201);
      return h.call('PATCH', `/v1/threads/${String(made.json.id)}`, {
        token,
        headers: { 'If-Match': made.headers.get('etag') ?? '*' },
        body: { state: 'resolved' },
      });
    },
  },
  {
    // Row 8: `edit` somewhere in the document.
    row: 'version.create',
    succeeds: true,
    allowed: (w) => holds(w, 'edit'),
    call: (doc, token, h) =>
      h.call('POST', `/v1/documents/${doc}/versions`, {
        token,
        body: { name: `prm-056 ${uuid7()}` },
      }),
  },
  {
    // Row 11: `edit` in the region. A lease has a holder, so the service credential is refused.
    // The region is one that inherits, so the document role decides. A lease taken is released,
    // so that the next case does not meet it.
    row: 'lease.acquire',
    succeeds: true,
    allowed: (w) => w !== 'service' && holds(w, 'edit'),
    call: async (doc, token, h) => {
      const path = `/v1/documents/${doc}/regions/${OPEN_REGION}/lease`;
      const r = await h.call('POST', path, { token, body: {} });
      if (r.status === 201) {
        const gone = await h.call('DELETE', path, { token });
        expect(gone.status, gone.text).toBeLessThan(300);
      }
      return r;
    },
  },
  {
    // Row 9 (HIS-018 is built): `edit` in the region, here one that inherits, so the document role
    // decides. A dry run reaches the guard and the plan and stores nothing, so the cases do not
    // change the document for the cases after them.
    row: 'restore.region',
    succeeds: true,
    allowed: (w) => holds(w, 'edit'),
    call: (doc, token, h) =>
      h.call('POST', `/v1/documents/${doc}/restore`, {
        token,
        body: { toSeq: 0, region: OPEN_REGION, dryRun: true },
      }),
  },
  {
    row: 'manage',
    allowed: (w) => holds(w, 'manage'),
    call: async (doc, token, h) => {
      const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
      return h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token,
        headers: { 'If-Match': g.headers.get('etag') ?? '*' },
        body: { grants: [] },
      });
    },
  },
  {
    row: 'export',
    allowed: (w) => holds(w, 'view'),
    call: (doc, token, h) =>
      h.call('POST', `/v1/documents/${doc}/exports`, { token, body: { format: 'pdf' } }),
  },
  {
    row: 'service',
    allowed: (w) => w === 'service',
    call: (_doc, token, h) => h.call('GET', '/v1/audit', { token }),
  },
];

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`PRM-056 criterion 5: the matrix rows, generated per role (${storage})`, () => {
    let h: Harness;
    let doc: string;
    let other: string;
    const tokens = new Map<Who, string>();

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      doc = await h.createDocument(h.a, documentWithRegions());
      other = await h.createDocument(h.a, documentWithRegions());
      for (const who of WHO) {
        if (who === 'service') tokens.set(who, h.a.apiKey);
        else if (who === 'outsider')
          tokens.set(who, await h.mintToken(h.a, 'prm056-outsider', { [other]: 'owner' }));
        else tokens.set(who, await h.mintToken(h.a, `prm056-${who}`, { [doc]: who }));
      }
    }, 120_000);

    afterAll(async () => {
      await h?.close();
    });

    const t = () => (skip ? it.skip : it);

    for (const c of ROWS) {
      t()(`row ${c.row} is in the matrix`, () => {
        expect(MATRIX.some((r) => r.id === c.row)).toBe(true);
      });
      for (const who of WHO) {
        const want = c.allowed(who);
        t()(
          `row ${c.row}: ${who} is ${want ? 'let through' : 'refused with forbidden'}`,
          async () => {
            const r = await c.call(doc, tokens.get(who)!, h, tokens.get('owner')!);
            if (want) {
              expect(r.status, `${r.status} ${r.text.slice(0, 200)}`).not.toBe(403);
              expect(r.status).not.toBe(401);
              if (c.succeeds) expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
            } else if (c.hiddenFromOutsider && who === 'outsider') {
              expect(r.status, `${r.status} ${r.text.slice(0, 200)}`).toBe(404);
              expect(r.json?.['code']).toBe('not_found');
            } else {
              expect(r.status, `${r.status} ${r.text.slice(0, 200)}`).toBe(403);
              expect(r.json?.['code']).toBe('forbidden');
            }
          },
        );
      }
    }

    // Row 3: a commit over the wire (`sync.submit`). The requirement is the outcome check of
    // 07 §5; the generated commit types plain text into a body paragraph, which needs `edit` there
    // (P1). Every other principal is refused: a role without `edit` by the check, and a token with
    // no role on the document, or the service credential, before a channel opens.
    t()('row commit is in the matrix', () => {
      expect(MATRIX.find((r) => r.id === 'commit')?.messages).toContain('sync.submit');
    });
    for (const who of WHO) {
      const want = who !== 'service' && holds(who, 'edit');
      t()(
        `row commit: ${who} is ${want ? 'acknowledged' : 'refused and nothing is stored'}`,
        async () => {
          const read = async () => {
            const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
            expect(r.status).toBe(200);
            return { doc: r.json.doc as unknown, seq: Number(r.json.seq ?? 0) };
          };
          const before = await read();
          const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
          let answer: { t: string; code?: unknown };
          try {
            await c.hello(tokens.get(who)!);
            await c.open(1, doc);
            const r = await c.submit(1, {
              id: uuid7(),
              base: before.seq,
              steps: [insertText(posInside(before.doc, 'pIntro0000000001'), 'x')],
            });
            answer = { t: r.t, code: r.d?.['code'] };
          } catch (e) {
            // The connection was closed before a channel opened: no commit was taken.
            answer = { t: 'closed', code: String(e) };
          } finally {
            c.terminate();
          }
          const after = await read();
          if (want) {
            expect(answer.t, JSON.stringify(answer)).toBe('sync.ack');
            expect(after.seq).toBe(before.seq + 1);
          } else {
            expect(answer.t, JSON.stringify(answer)).not.toBe('sync.ack');
            // A role on the document that lacks `edit` gets the authority's refusal.
            if (who !== 'outsider' && who !== 'service') {
              expect(answer.t).toBe('sync.reject');
              expect(answer.code).toBe('permission_denied');
            }
            expect(after.seq).toBe(before.seq);
            expect(after.doc).toEqual(before.doc);
          }
        },
      );
    }
  });
}
