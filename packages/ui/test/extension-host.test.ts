/**
 * Register host extensions (UX-050; 13 §7.1, §7.2). Node.js tests of `ExtensionHost`: validation
 * of each entry on its own, the API-version check, runtime add and remove, and activation errors.
 * Ticked on these: criterion 1 (a bad manifest is rejected with a non-fatal report that names it,
 * and the others load), criterion 2 (an unsupported API version is not activated and the reason is
 * reported), criterion 3 (contributions appear and disappear as the array changes, with no reload),
 * and criterion 5 (a throwing extension is reported and the others, and the editor, carry on).
 * Not claimed: criterion 4 (documentation is not written here) and criterion 6 (the reference host's
 * sample extension is not built, so its automated test cannot run).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ExtensionHost, checkManifest, type ExtensionReport } from '../src/extensions/host.ts';

interface Api {
  readonly id: string;
  readonly track: (dispose: () => void) => void;
}

function harness(apiVersions: readonly string[] = ['1']) {
  const reports: ExtensionReport[] = [];
  const host = new ExtensionHost<Api>({
    apiVersions,
    createApi: (id, track) => ({ id, track }),
    onError: (report) => reports.push(report),
  });
  return { host, reports };
}

function manifest(id: string, apiVersion = '1') {
  return { id, name: `Sample ${id}`, apiVersion };
}

describe('checkManifest (UX-050 criterion 1)', () => {
  it('accepts a complete manifest and trims its name and version', () => {
    const r = checkManifest({ id: 'sample.tags', name: '  Tags ', apiVersion: ' 1 ' }, 1);
    expect(r).toEqual({ ok: true, manifest: { id: 'sample.tags', name: 'Tags', apiVersion: '1' } });
  });

  it('refuses a missing manifest, a bad identifier, an empty name and no API version', () => {
    expect(checkManifest(undefined, 1).ok).toBe(false);
    expect(checkManifest({ id: 'Upper', name: 'x', apiVersion: '1' }, 2).ok).toBe(false);
    expect(checkManifest({ id: 'x'.repeat(65), name: 'x', apiVersion: '1' }, 3).ok).toBe(false);
    expect(checkManifest({ id: 'ok', name: '   ', apiVersion: '1' }, 4).ok).toBe(false);
    expect(checkManifest({ id: 'ok', name: 'x' }, 5).ok).toBe(false);
  });

  it('names a refused entry by its position when it has no identifier', () => {
    const r = checkManifest({ name: 'x', apiVersion: '1' }, 3);
    expect(r).toMatchObject({ ok: false, label: '#3' });
  });
});

describe('ExtensionHost validation and activation (UX-050 criteria 1 and 2)', () => {
  it('rejects a bad entry with a non-fatal report that names it and loads the others', () => {
    const { host, reports } = harness();
    const loaded: string[] = [];
    host.sync([
      {
        manifest: { id: 'Bad Id', name: 'x', apiVersion: '1' },
        activate: () => loaded.push('bad'),
      },
      { manifest: manifest('good.one'), activate: () => loaded.push('good.one') },
      { manifest: manifest('good.two'), activate: () => loaded.push('good.two') },
    ]);
    expect(loaded).toEqual(['good.one', 'good.two']);
    expect(host.active()).toEqual(['good.one', 'good.two']);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ extension: '#1', reason: 'invalid-manifest', fatal: false });
  });

  it('refuses an entry with no activate function and names it by identifier', () => {
    const { host, reports } = harness();
    host.sync([{ manifest: manifest('no.code'), activate: undefined }]);
    expect(host.active()).toEqual([]);
    expect(reports).toEqual([
      expect.objectContaining({ extension: 'no.code', reason: 'invalid-manifest', fatal: false }),
    ]);
  });

  it('keeps the first of two extensions with the same identifier and reports the second', () => {
    const { host, reports } = harness();
    const seen: string[] = [];
    host.sync([
      { manifest: manifest('dup'), activate: () => seen.push('first') },
      { manifest: manifest('dup'), activate: () => seen.push('second') },
    ]);
    expect(seen).toEqual(['first']);
    expect(reports[0]).toMatchObject({ extension: 'dup', reason: 'duplicate-id' });
  });

  it('does not activate an extension whose API version is unsupported, and says why', () => {
    const { host, reports } = harness(['1']);
    let called = false;
    host.sync([{ manifest: manifest('future', '2'), activate: () => (called = true) }]);
    expect(called).toBe(false);
    expect(host.active()).toEqual([]);
    expect(reports).toEqual([
      expect.objectContaining({
        extension: 'future',
        reason: 'unsupported-api-version',
        fatal: false,
      }),
    ]);
  });

  it('gives each extension an API that tracks its own contributions', () => {
    const { host } = harness();
    const disposed: string[] = [];
    host.sync([
      {
        manifest: manifest('a'),
        activate: (api: Api) => api.track(() => disposed.push('a:1')),
      },
    ]);
    host.dispose();
    expect(disposed).toEqual(['a:1']);
    expect(host.active()).toEqual([]);
  });
});

describe('ExtensionHost runtime changes (UX-050 criterion 3)', () => {
  it('removes an extension and disposes what it tracked when it leaves the array', () => {
    const { host, reports } = harness();
    const disposed: string[] = [];
    const a = {
      manifest: manifest('a'),
      activate: (api: Api) => {
        api.track(() => disposed.push('a:panel'));
        api.track(() => disposed.push('a:command'));
      },
    };
    const b = { manifest: manifest('b'), activate: () => undefined };
    host.sync([a, b]);
    expect(host.active()).toEqual(['a', 'b']);
    host.sync([b]);
    expect(host.active()).toEqual(['b']);
    expect(disposed).toEqual(['a:command', 'a:panel']);
    expect(reports).toEqual([]);
  });

  it('keeps an extension that is still listed with the same activate function', () => {
    const { host } = harness();
    let activations = 0;
    const activate = () => {
      activations++;
    };
    const entry = { manifest: manifest('a'), activate };
    host.sync([entry]);
    host.sync([entry]);
    host.sync([{ ...entry }]);
    expect(activations).toBe(1);
  });

  it('activates an extension added later without reloading the others', () => {
    const { host } = harness();
    const seen: string[] = [];
    const a = { manifest: manifest('a'), activate: () => seen.push('a') };
    const b = { manifest: manifest('b'), activate: () => seen.push('b') };
    host.sync([a]);
    host.sync([a, b]);
    expect(seen).toEqual(['a', 'b']);
  });

  it('property: after any sequence of syncs the active set is the valid, supported, first-of-id entries that activated', () => {
    const ids = ['a', 'b', 'c'];
    const versions = ['1', '2'];
    const entryArb = fc.record({
      id: fc.constantFrom(...ids),
      apiVersion: fc.constantFrom(...versions),
      throws: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(fc.array(entryArb, { maxLength: 5 }), { maxLength: 6 }), (rounds) => {
        const { host, reports } = harness(['1']);
        // Outstanding contributions per identifier: +1 on activation, -1 when disposed.
        const outstanding = new Map<string, number>();
        for (const round of rounds) {
          const expected = new Set<string>();
          const entries = round.map((e) => ({
            manifest: manifest(e.id, e.apiVersion),
            // A fresh function each round, so every listed extension is re-activated (sync keeps
            // only the same function); the property then covers activation and removal.
            activate: (api: Api) => {
              if (e.throws) throw new Error('boom');
              api.track(() => outstanding.set(e.id, (outstanding.get(e.id) ?? 0) - 1));
              outstanding.set(e.id, (outstanding.get(e.id) ?? 0) + 1);
            },
          }));
          // The expected active set: each identifier is claimed by its first entry with a supported
          // version (the others are duplicates), and it is active unless its activation throws.
          const claimed = new Set<string>();
          for (const e of round) {
            if (e.apiVersion !== '1' || claimed.has(e.id)) continue;
            claimed.add(e.id);
            if (!e.throws) expected.add(e.id);
          }
          host.sync(entries);
          expect(new Set(host.active())).toEqual(expected);
          for (const id of ids) expect(outstanding.get(id) ?? 0).toBe(expected.has(id) ? 1 : 0);
        }
        for (const r of reports) expect(r.fatal).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe('ExtensionHost activation errors (UX-050 criterion 5)', () => {
  it('reports a throwing activate, undoes its partial contributions and loads the others', () => {
    const { host, reports } = harness();
    const undone: string[] = [];
    const loaded: string[] = [];
    host.sync([
      {
        manifest: manifest('broken'),
        activate: (api: Api) => {
          api.track(() => undone.push('broken:partial'));
          throw new Error('startup failed');
        },
      },
      { manifest: manifest('fine'), activate: () => loaded.push('fine') },
    ]);
    expect(undone).toEqual(['broken:partial']);
    expect(loaded).toEqual(['fine']);
    expect(host.active()).toEqual(['fine']);
    expect(reports).toEqual([
      expect.objectContaining({
        extension: 'broken',
        reason: 'activation-failed',
        message: 'startup failed',
        fatal: false,
      }),
    ]);
  });

  it('keeps the host working when the error sink itself throws', () => {
    const host = new ExtensionHost<Api>({
      apiVersions: ['1'],
      createApi: (id, track) => ({ id, track }),
      onError: () => {
        throw new Error('sink failed');
      },
    });
    expect(() =>
      host.sync([
        {
          manifest: manifest('x'),
          activate: () => {
            throw new Error('no');
          },
        },
      ]),
    ).not.toThrow();
    expect(host.active()).toEqual([]);
  });
});
