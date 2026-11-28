// UX-108 criterion 1: the seed holds a form document that requires `fields`, with roles and fields,
// made from the lease template's content. Reads the seed files only; the stack run is not here.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDocumentsSeed, templateContent } from '../src/lib/server/documents.ts';

const SEED = join(import.meta.dirname, '..', 'seed');

function nodeTypes(node: unknown, out: string[] = []): string[] {
  if (node && typeof node === 'object') {
    const n = node as { type?: unknown; content?: unknown };
    if (typeof n.type === 'string') out.push(n.type);
    if (Array.isArray(n.content)) for (const c of n.content) nodeTypes(c, out);
  }
  return out;
}

describe('UX-108 seeded form document', () => {
  it('seeds a document from the lease template that requires fields, with roles and fields', async () => {
    const seed = await loadDocumentsSeed(SEED);
    const doc = seed.documents.find((d) => d.externalId === 'demo-lease-form');
    expect(doc).toBeDefined();
    const template = seed.templates.find((t) => t.key === doc!.template);
    expect(template).toBeDefined();
    const envelope = await templateContent(SEED, template!);
    expect(envelope.requires).toContain('fields');
    const types = nodeTypes(envelope.doc);
    expect(types).toContain('role_def');
    expect(types.filter((t) => t === 'form_field').length).toBeGreaterThan(0);
    expect(doc!.creator).toBe('u-olivia');
  });

  it('keeps the supply agreement a plain document (requires is empty)', async () => {
    const seed = await loadDocumentsSeed(SEED);
    const doc = seed.documents.find((d) => d.externalId === 'demo-supply-agreement');
    const template = seed.templates.find((t) => t.key === doc?.template);
    const envelope = JSON.parse(await readFile(join(SEED, template!.content), 'utf8')) as {
      requires: string[];
    };
    expect(envelope.requires).toEqual([]);
  });
});
