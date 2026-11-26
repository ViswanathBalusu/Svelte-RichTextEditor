/**
 * The reference host's sample extension (UX-050 criterion 6) at the level of its code, with a stand-in
 * for the API an extension is given, and the guide's statements about it (UX-050 criterion 4;
 * UX-054 criterion 4). The extension in a real element, with its panel, status item and axe, is
 * packages/element/e2e/ux-050-sample-extension.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostExtensionApi } from '@docedit/element';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_EXTENSION_ID,
  SAMPLE_IMPORT_FILTER_ID,
  SAMPLE_PANEL_ID,
  SAMPLE_STRINGS,
  noteFallback,
  noteFragment,
  sampleExtension,
} from '../src/lib/sample-extension.ts';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = readFileSync(join(HOST, 'docs', 'integration-guide.md'), 'utf8');

type Draft = { extension: string; payload: unknown; fallbackText?: string | null };

function standIn(opts: { document: boolean; refuse?: boolean }) {
  const commands = new Map<string, { run: (c: unknown) => boolean; changesContent: boolean }>();
  const panels: Array<{ id: string; label: string }> = [];
  const items: Array<{ id: string; position: string; text: string; label: string }> = [];
  const inserted: Draft[] = [];
  const released: unknown[] = [];
  const opened: string[] = [];
  const filters: Array<{
    id: string;
    kind: string;
    extensions: string[];
    run: (i: unknown) => unknown;
  }> = [];
  const range = { id: 'r1' };
  const api = {
    registerCommand: (c: { id: string; run: (x: unknown) => boolean; changesContent: boolean }) => {
      commands.set(c.id, c);
    },
    registerPanel: (p: { id: string; label: string }) => void panels.push(p),
    openPanel: (id: string) => {
      opened.push(id);
      return Promise.resolve(true);
    },
    addStatusItem: (i: { id: string; position: string; text: string; label: string }) =>
      void items.push(i),
    onRemove: () => {},
    registerFilter: (f: (typeof filters)[number]) => void filters.push(f),
    document: opts.document
      ? {
          selection: () => range,
          release: (r: unknown) => void released.push(r),
          insertExtensionBlock: (_at: unknown, draft: Draft) => {
            inserted.push(draft);
            return opts.refuse
              ? { ok: false, reason: 'permission_denied', message: 'no' }
              : { ok: true, id: 'b1' };
          },
        }
      : null,
  };
  return {
    api: api as unknown as HostExtensionApi,
    commands,
    panels,
    items,
    inserted,
    released,
    opened,
    filters,
  };
}

describe('the sample extension (UX-050 criterion 6)', () => {
  it('has a valid manifest for the API version the editor supports', () => {
    expect(sampleExtension.manifest).toMatchObject({ id: SAMPLE_EXTENSION_ID, apiVersion: '1' });
    expect(sampleExtension.manifest.name.trim()).not.toBe('');
  });

  it('contributes a command, a panel, a second command that opens it, and a status item', () => {
    const s = standIn({ document: true });
    sampleExtension.activate(s.api);
    expect([...s.commands.keys()].sort()).toEqual(['sample.insert-note', 'sample.open-notes']);
    expect(s.panels).toEqual([
      { id: SAMPLE_PANEL_ID, label: 'Sample notes', mount: expect.any(Function) },
    ]);
    expect(s.items).toEqual([
      {
        id: 'sample.status',
        position: 'end',
        text: 'Sample extension',
        label: 'The sample extension is active',
      },
    ]);
    // Every command label is a key the page supplies in `strings`.
    for (const id of s.commands.keys()) expect(SAMPLE_STRINGS[id]).toBeTruthy();
    expect(s.commands.get('sample.open-notes')!.run({})).toBe(true);
    expect(s.opened).toEqual([SAMPLE_PANEL_ID]);
  });

  it('inserts a custom block with the extension identifier, a payload and a text fallback', () => {
    const s = standIn({ document: true });
    sampleExtension.activate(s.api);
    const insert = s.commands.get('sample.insert-note')!;
    expect(insert.changesContent).toBe(true);
    expect(insert.run({})).toBe(true);
    expect(insert.run({})).toBe(true);
    expect(s.inserted).toEqual([
      {
        extension: SAMPLE_EXTENSION_ID,
        payload: { note: noteFallback(1) },
        fallbackText: noteFallback(1),
      },
      {
        extension: SAMPLE_EXTENSION_ID,
        payload: { note: noteFallback(2) },
        fallbackText: noteFallback(2),
      },
    ]);
    // The held range is released after each write.
    expect(s.released).toHaveLength(2);
  });

  it('contributes an import filter that turns a .note file into a one-paragraph fragment', () => {
    const s = standIn({ document: true });
    sampleExtension.activate(s.api);
    expect(s.filters).toHaveLength(1);
    const filter = s.filters[0]!;
    expect(filter).toMatchObject({
      id: SAMPLE_IMPORT_FILTER_ID,
      kind: 'import',
      extensions: ['note'],
    });
    const bytes = new TextEncoder().encode('  Hello from a file.  \n');
    expect(filter.run({ bytes, name: 'a.note' })).toEqual(noteFragment('Hello from a file.'));
    expect(noteFragment('x')).toMatchObject({
      cdm: 1,
      requires: [],
      content: [{ type: 'paragraph' }],
    });
  });

  it('reports false, and releases the range, when the document API refuses or is absent', () => {
    const refused = standIn({ document: true, refuse: true });
    sampleExtension.activate(refused.api);
    expect(refused.commands.get('sample.insert-note')!.run({})).toBe(false);
    expect(refused.released).toHaveLength(1);
    const absent = standIn({ document: false });
    sampleExtension.activate(absent.api);
    expect(absent.commands.get('sample.insert-note')!.run({})).toBe(false);
  });
});

describe('the integration guide on extensions (UX-050 criterion 4; UX-054 criterion 4)', () => {
  const section = GUIDE.slice(
    GUIDE.indexOf('## Extensions (UX-050'),
    GUIDE.indexOf('## Backend tiers'),
  );

  it('says a tier 1 extension runs in the page with the host trust', () => {
    expect(section).toContain("Tier 1 extensions run in the page, with the host's trust");
  });

  it('describes the sample extension and where it is', () => {
    expect(section).toContain('### The sample extension');
    expect(section).toContain('src/lib/sample-extension.ts');
    expect(section).toContain('?sample-extension');
  });

  it('says that no hook can veto or alter a keystroke', () => {
    expect(section).toContain('### Hooks never sit on the typing path');
    expect(section).toContain('No hook can veto, delay or alter a keystroke');
  });
});
