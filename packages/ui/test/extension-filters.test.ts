/**
 * Client import and export filters (UX-055; 13 §7.1): the registry's logic. The choices list each
 * filter with its label, `no-export` disables export choices and stops the filter, an export filter
 * receives the content and yields a file (in memory), and a filter that throws is reported with the
 * content unchanged. The product path (the export dialog, the file to save) is tested in the
 * browser, e2e/extensions.spec.ts. Criterion 1 is not claimed: the fragment's insertion through
 * the guards of typing is the core's and the caller's.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  FilterRegistrationError,
  FilterRegistry,
  NO_EXPORT,
  toBlob,
  type ExportFilter,
  type ImportFilter,
} from '../src/extensions/filters.ts';

const LABEL = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim() !== '');

function markdownExport(run?: ExportFilter<unknown>['run']): ExportFilter<unknown> {
  return {
    kind: 'export',
    id: 'ext.markdown-out',
    label: 'Markdown',
    mimeType: 'text/markdown',
    extension: 'md',
    run: run ?? (() => new TextEncoder().encode('# Title\n')),
  };
}

function markdownImport(): ImportFilter<{ blocks: string[] }> {
  return {
    kind: 'import',
    id: 'ext.markdown-in',
    label: 'Markdown file',
    extensions: ['md'],
    run: ({ bytes }) => ({ blocks: [new TextDecoder().decode(bytes)] }),
  };
}

function deepFrozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFrozen(v);
    Object.freeze(value);
  }
  return value;
}

describe('the choices list each filter with its label (UX-055, criterion 3)', () => {
  it('lists export and import choices separately, each with its label, in registration order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(LABEL, { minLength: 1, maxLength: 5 }), (labels) => {
        const registry = new FilterRegistry();
        labels.forEach((label, i) => {
          registry.add({ ...markdownExport(), id: `ext.out-${i}`, label });
          registry.add({ ...markdownImport(), id: `ext.in-${i}`, label: `${label} in` });
        });
        const exports = registry.choices('export');
        const imports = registry.choices('import');
        expect(exports.map((c) => c.label)).toEqual(labels);
        expect(imports.map((c) => c.label)).toEqual(labels.map((l) => `${l} in`));
        expect(exports.every((c) => c.kind === 'export' && c.enabled)).toBe(true);
      }),
    );
  });

  it('shows nothing for a kind with no filters', () => {
    const registry = new FilterRegistry();
    registry.add(markdownExport());
    expect(registry.choices('import')).toEqual([]);
  });
});

describe('no-export disables the export choices and refuses to run them (UX-055, criterion 4)', () => {
  it('lists export choices disabled with a reason under no-export, and import choices unchanged', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(NO_EXPORT, 'no-copy', 'no-print'), { maxLength: 3 }),
        (restrictions) => {
          const registry = new FilterRegistry();
          registry.add(markdownExport());
          registry.add(markdownImport());
          const limited = restrictions.includes(NO_EXPORT);
          const [out] = registry.choices('export', restrictions);
          const [inp] = registry.choices('import', restrictions);
          expect(out?.enabled).toBe(!limited);
          expect(out?.reason).toBe(limited ? 'no-export' : null);
          expect(inp?.enabled).toBe(true);
        },
      ),
    );
  });

  it('does not run the export filter under no-export', async () => {
    let ran = 0;
    const registry = new FilterRegistry();
    registry.add(
      markdownExport(() => {
        ran++;
        return new Uint8Array();
      }),
    );
    const outcome = await registry.runExport('ext.markdown-out', { title: 'x' }, [NO_EXPORT]);
    expect(outcome).toEqual({ ok: false, reason: 'no-export' });
    expect(ran).toBe(0);
  });
});

describe('an export filter receives the content and yields a file (UX-055, criterion 2)', () => {
  it('passes the content it is given and returns the bytes with the file name and type', async () => {
    const seen: unknown[] = [];
    const registry = new FilterRegistry();
    registry.add(
      markdownExport((content) => {
        seen.push(content);
        return new TextEncoder().encode('# Title\n');
      }),
    );
    const content = { blocks: ['Title'] };
    const outcome = await registry.runExport('ext.markdown-out', content, [], 'report');
    expect(seen).toEqual([content]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.name).toBe('report.md');
    expect(outcome.mimeType).toBe('text/markdown');
    const blob = toBlob(outcome);
    expect(blob.type).toBe('text/markdown');
    expect(blob.size).toBe(outcome.bytes.byteLength);
  });

  it('reports an unknown identifier and a wrong kind without running anything', async () => {
    const registry = new FilterRegistry();
    registry.add(markdownImport());
    expect(await registry.runExport('ext.nothing', {})).toEqual({ ok: false, reason: 'unknown' });
    expect(await registry.runExport('ext.markdown-in', {})).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });
});

describe('a filter that throws is reported and the document is unchanged (UX-055, criterion 5)', () => {
  it('reports an export failure with its error and leaves the content as it was', async () => {
    const boom = new Error('cannot write');
    const registry = new FilterRegistry();
    registry.add(
      markdownExport(() => {
        throw boom;
      }),
    );
    const content = deepFrozen({ blocks: [{ text: 'kept' }] });
    const before = JSON.stringify(content);
    const outcome = await registry.runExport('ext.markdown-out', content);
    expect(outcome).toEqual({ ok: false, reason: 'failed', error: boom });
    expect(JSON.stringify(content)).toBe(before);
  });

  it('reports an import failure and inserts nothing', async () => {
    const boom = new Error('bad file');
    const registry = new FilterRegistry();
    registry.add({ ...markdownImport(), run: () => Promise.reject(boom) });
    let inserted = 0;
    const outcome = await registry.runImport(
      'ext.markdown-in',
      { bytes: new Uint8Array([1]), name: 'a.md' },
      () => {
        inserted++;
        return true;
      },
    );
    expect(outcome).toEqual({ ok: false, reason: 'failed', error: boom });
    expect(inserted).toBe(0);
  });

  it('a synchronous throw from an import is reported the same way', async () => {
    const registry = new FilterRegistry();
    registry.add({
      ...markdownImport(),
      run: () => {
        throw new Error('sync');
      },
    });
    const outcome = await registry.runImport(
      'ext.markdown-in',
      { bytes: new Uint8Array(), name: 'a.md' },
      () => true,
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("import mechanics (UX-055, criterion 1 not claimed: the insertion is the caller's guard)", () => {
  it('passes the fragment to the insert callback and reports a refusal', async () => {
    const registry = new FilterRegistry();
    registry.add(markdownImport());
    const file = { bytes: new TextEncoder().encode('Hello'), name: 'a.md' };
    const accepted = await registry.runImport<{ blocks: string[] }>(
      'ext.markdown-in',
      file,
      (f) => f.blocks.length === 1,
    );
    expect(accepted).toEqual({ ok: true, fragment: { blocks: ['Hello'] } });
    const refused = await registry.runImport('ext.markdown-in', file, () => false);
    expect(refused).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('registration names the filter when it is invalid', () => {
  it('refuses a duplicate identifier and keeps the first filter', () => {
    const registry = new FilterRegistry();
    registry.add(markdownExport());
    expect(() => registry.add({ ...markdownExport(), label: 'Other' })).toThrow(
      FilterRegistrationError,
    );
    expect(registry.choices('export').map((c) => c.label)).toEqual(['Markdown']);
  });

  it('refuses a bad identifier, an empty label, a missing MIME type or a missing extension', () => {
    const registry = new FilterRegistry();
    expect(() => registry.add({ ...markdownExport(), id: 'Bad' })).toThrow(/ext|area/);
    expect(() => registry.add({ ...markdownExport(), label: '  ' })).toThrow(
      FilterRegistrationError,
    );
    expect(() => registry.add({ ...markdownExport(), mimeType: 'markdown' })).toThrow(
      FilterRegistrationError,
    );
    expect(() => registry.add({ ...markdownExport(), extension: '.md' })).toThrow(
      FilterRegistrationError,
    );
    expect(() => registry.add({ ...markdownImport(), extensions: [] })).toThrow(
      FilterRegistrationError,
    );
  });

  it('removes a filter through the function add returned', () => {
    const registry = new FilterRegistry();
    const remove = registry.add(markdownExport());
    remove();
    expect(registry.choices('export')).toEqual([]);
  });
});
