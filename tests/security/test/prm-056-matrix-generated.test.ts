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
 * Rows not generated here: 3 (a commit over the wire; the verdicts are in prm-057-row3-verdicts),
 * 4, 5 and 8 (the service serves no thread or version route), 9 (no restore route for a region) and
 * 11 (a region lease, whose check is by region and not a document role). Those stay open in the
 * story's Notes.
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
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type CallResult,
  type Harness,
  type Storage,
} from './support/harness.ts';

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
  /** The call, with the document identifier. */
  call: (doc: string, token: string, h: Harness) => Promise<CallResult>;
}

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
            const r = await c.call(doc, tokens.get(who)!, h);
            if (want) {
              expect(r.status, `${r.status} ${r.text.slice(0, 200)}`).not.toBe(403);
              expect(r.status).not.toBe(401);
            } else {
              expect(r.status, `${r.status} ${r.text.slice(0, 200)}`).toBe(403);
              expect(r.json?.['code']).toBe('forbidden');
            }
          },
        );
      }
    }
  });
}
