// The embedding reference (UX-090, criterion 3): generated from the element's source and the command
// registry, it lists every attribute, public property and method, event, command identifier and
// configuration key, and the versions; the committed files are the generator's current output.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinCommands } from '../src/commands/builtin.ts';
import {
  REFERENCE_JSON,
  REFERENCE_MARKDOWN,
  buildEmbeddingReference,
  extractEvents,
  extractMembers,
  type ReferenceInput,
} from '../scripts/embedding-reference.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const element = (name: string) => read(`packages/element/src/${name}`);

const input: ReferenceInput = {
  docEditorSource: element('doc-editor.ts'),
  eventsSource: element('events.ts'),
  versionSource: element('version.ts'),
  registerSource: element('register.ts'),
  configSchema: JSON.parse(element('config.schema.json')),
  commands: builtinCommands().map((c) => ({
    id: c.id,
    group: c.group,
    capability: c.capability,
    keys: c.keys ?? [],
    aliases: c.aliases ?? [],
  })),
};
const result = buildEmbeddingReference(input);
const normal = (text: string) => text.replace(/\r\n/g, '\n');

describe('the embedding reference', () => {
  it('builds without a problem and is what is committed under spec/embedding', () => {
    expect(result.problems).toEqual([]);
    for (const a of result.artifacts) expect(normal(read(a.path))).toBe(normal(a.text));
    expect(result.artifacts.map((a) => a.path)).toEqual([REFERENCE_JSON, REFERENCE_MARKDOWN]);
  });

  it('states the embedding version, the release and the tag from the element', () => {
    expect(result.reference.embeddingVersion).toBe(
      /EMBEDDING_VERSION = '([^']+)'/.exec(input.versionSource)![1],
    );
    expect(result.reference.release).toBe(
      JSON.parse(read('packages/element/package.json')).version,
    );
    expect(result.reference.tag).toBe('doc-editor');
  });

  it('lists every observed attribute', () => {
    const block = /OBSERVED_ATTRIBUTES = \[([^\]]+)\]/.exec(input.docEditorSource)![1]!;
    const expected = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(expected.length).toBeGreaterThan(5);
    expect(result.reference.attributes).toEqual(expected);
  });

  it('lists every public method and property of the class, and no private one', () => {
    const names = result.reference.members.map((m) => m.name);
    const body = input.docEditorSource.slice(
      input.docEditorSource.indexOf('export class DocEditorElement'),
    );
    // Methods written at the class's own indentation, public by default and not `#private`.
    const methods = [...body.matchAll(/^ {2}(?:override )?(?:async )?([a-z][A-Za-z]*)\(/gm)]
      .map((m) => m[1]!)
      .filter((n) => !/Callback$/.test(n) && n !== 'constructor');
    expect(methods).toContain('exec');
    for (const name of methods) expect(names, `method ${name}`).toContain(name);
    const accessors = [...body.matchAll(/^ {2}(?:get|set) ([a-z][A-Za-z]*)\(/gm)].map((m) => m[1]!);
    expect(accessors).toContain('getToken');
    for (const name of accessors) expect(names, `property ${name}`).toContain(name);
    expect(names.some((n) => n.startsWith('#'))).toBe(false);
    expect(names).not.toContain('constructor');
    const write = result.reference.members.find((m) => m.name === 'getToken')!;
    expect(write.access).toBe('read/write');
    expect(result.reference.members.find((m) => m.name === 'headerState')!.access).toBe('read');
    expect(result.reference.reactions).toContain('connectedCallback');
  });

  it('lists every event with its detail type', () => {
    const names = [...input.eventsSource.matchAll(/^ {2}'(de-[a-z-]+)':/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(15);
    expect(result.reference.events.map((e) => e.name)).toEqual(names);
    expect(result.reference.events.find((e) => e.name === 'de-ready')!.detail).toBe(
      '{ docId: string; seq: number }',
    );
  });

  it('lists every command identifier of the registry and every configuration key', () => {
    expect(result.reference.commands.map((c) => c.id).sort()).toEqual(
      builtinCommands()
        .map((c) => c.id)
        .sort(),
    );
    const keys = Object.keys(JSON.parse(element('config.schema.json')).properties);
    expect(result.reference.config.map((c) => c.name)).toEqual(keys);
    const graceMs = result.reference.config.find((c) => c.name === 'graceMs')!;
    expect(graceMs.default).toBe('30000');
  });

  it('is written for a reader: the markdown has a section for each kind of thing', () => {
    const md = result.artifacts.find((a) => a.path === REFERENCE_MARKDOWN)!.text;
    for (const h of [
      '## Attributes',
      '## Properties and methods',
      '## Events',
      '## Commands',
      '## Configuration',
    ])
      expect(md).toContain(h);
    expect(md).toContain('| `exec` | method | call |');
    expect(md).toContain('| `de-error` |');
  });
});

describe('the generator refuses sources it does not understand', () => {
  it('a class that is not there, or has no event map, is a problem and not an empty reference', () => {
    expect(extractMembers('export class Other {}', 'DocEditorElement').problems).toEqual([
      'class DocEditorElement not found',
    ]);
    expect(extractEvents('export const X = 1;').problems).toEqual([
      'interface DocEditorEventMap not found',
    ]);
    const bad = buildEmbeddingReference({ ...input, docEditorSource: 'export const x = 1;' });
    expect(bad.problems).toContain('class DocEditorElement not found');
    expect(bad.problems).toContain('OBSERVED_ATTRIBUTES not found');
  });

  it('an event listed in EVENT_NAMES but not in the map is a problem', () => {
    const src = `export interface DocEditorEventMap { 'de-a': { x: 1 }; }\nexport const EVENT_NAMES = ['de-a', 'de-b'] as const;`;
    expect(extractEvents(src).problems).toEqual([
      'EVENT_NAMES and DocEditorEventMap list different events',
    ]);
  });

  it('private and protected members and #names are not listed', () => {
    const src = `class C { #a = 1; private b = 2; protected c(): void {} d(): void {} get e(): number { return 1; } }`;
    expect(extractMembers(src, 'C').members.map((m) => m.name)).toEqual(['d', 'e']);
  });
});
