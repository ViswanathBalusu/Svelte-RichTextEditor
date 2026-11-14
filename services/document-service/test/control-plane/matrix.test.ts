// The route guards follow the one authorisation matrix of 07 §12 (PRM-056; packages/authority
// permissions/matrix.ts): the service-credential row matches the credentials of the published
// routes, every route this server offers is in a row or classified, and guards use known rows.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MATRIX, UNMATRIXED_ROUTES } from '@docedit/authority';
import { DEP1 } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { createHandlers } from '../../src/control-plane/handlers.ts';

const route = (o: { method: string; path: string }) => `${o.method} ${o.path}`;

describe('route guards and the authorisation matrix (PRM-056 criterion 3)', () => {
  it('gives row 13 (service credential) exactly to routes that take only a service credential', () => {
    const serviceOnly = DEP1.operations
      .filter((o) => o.security.length === 1 && o.security[0] === 'service')
      .map(route);
    const row = MATRIX.find((r) => r.id === 'service')!;
    expect([...row.routes].sort()).toEqual(serviceOnly.sort());
  });

  it('has a row or a classification for every route this server offers', () => {
    const offered = Object.keys(createHandlers({} as never)).map((id) =>
      route(DEP1.operations.find((o) => o.operationId === id)!),
    );
    const known = new Set([
      ...MATRIX.flatMap((r) => r.routes),
      ...UNMATRIXED_ROUTES.map((r) => r.route),
    ]);
    for (const r of offered) expect(known.has(r), r).toBe(true);
  });

  it('calls only rows the matrix has', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/control-plane/handlers.ts', import.meta.url)),
      'utf8',
    );
    const rows = [
      ...src.matchAll(
        /guard\(ctx\.caller, (?:'([a-z.]+)'|seq === undefined \? '([a-z.]+)' : '([a-z.]+)')/g,
      ),
    ].flatMap((m) => m.slice(1).filter(Boolean));
    expect(rows.length).toBeGreaterThan(8);
    for (const r of rows)
      expect(
        MATRIX.some((x) => x.id === r),
        r,
      ).toBe(true);
  });
});
