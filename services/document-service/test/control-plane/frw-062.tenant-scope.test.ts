/**
 * FRW-062: a template belongs to one tenant. The store answers a tenant only with its own
 * templates, by list and by identifier, and a document is a template of its own tenant only.
 */
import { describe, expect, it } from 'vitest';
import { MemoryTemplateStore, type TemplateRecord } from '../../src/workflow/template-store.ts';

const record = (id: string, doc: string): TemplateRecord => ({
  id,
  doc,
  name: `template ${id}`,
  createdBy: 'svc',
  createdAtMs: 1,
});

describe('templates are scoped to their tenant (FRW-062)', () => {
  it('shows a tenant nothing of another tenant by list or by identifier', async () => {
    const store = new MemoryTemplateStore();
    expect(await store.create('tenant-a', record('t-a', 'doc-a'))).toBe('created');
    expect(await store.create('tenant-b', record('t-b', 'doc-b'))).toBe('created');

    expect((await store.list('tenant-a')).map((r) => r.id)).toEqual(['t-a']);
    expect((await store.list('tenant-b')).map((r) => r.id)).toEqual(['t-b']);
    expect(await store.get('tenant-a', 't-b')).toBeNull();
    expect(await store.get('tenant-b', 't-a')).toBeNull();
    expect((await store.get('tenant-a', 't-a'))?.doc).toBe('doc-a');
    expect(await store.list('tenant-c')).toEqual([]);
  });

  it('marks the same document identifier as a template in each tenant independently', async () => {
    const store = new MemoryTemplateStore();
    expect(await store.create('tenant-a', record('t-1', 'doc-x'))).toBe('created');
    expect(await store.create('tenant-b', record('t-2', 'doc-x'))).toBe('created');
    expect(await store.create('tenant-a', record('t-3', 'doc-x'))).toBe('exists');
  });
});
