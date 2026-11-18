// The `config` property (PRO-081 criteria 1 to 3; PRO-005). Pure functions, so these run in
// Node.js. The generator is a seeded linear congruential generator, so every run sees the same
// 300 cases; fast-check is not a dependency of this package.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GRACE_MS, normaliseConfig, type NormalConfig } from '../src/config.ts';

const KNOWN = [
  'styleNonce',
  'graceMs',
  'pdfViewerUrl',
  'katexFontsUrl',
  'selectionShim',
  'footnoteModel',
  'deferRemoteWhileComposing',
  'forceStyleFallback',
  'pageGuides',
  'features',
] as const;

/** Names the config must ignore, including ones that could reach a prototype if copied naively. */
const UNKNOWN_NAMES = [
  'theme',
  'fonts',
  'shortcuts',
  'limits',
  'featureSwitches',
  'nested',
  'constructor',
  'toString',
  'hasOwnProperty',
  '__proto__',
  'graceMs2',
  'STYLENONCE',
  '',
];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

/** A value of any JSON-like or odd type, the kind a host may put under a key. */
function anyValue(next: () => number, depth = 0): unknown {
  const kind = Math.floor(next() * (depth > 1 ? 5 : 8));
  switch (kind) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return next() < 0.5;
    case 3:
      return next() * 1e6 - 5e5;
    case 4:
      return pick(next, ['', 'x', 'library', 'https://example.test/v.html', 'n-1']);
    case 5:
      return [anyValue(next, depth + 1)];
    case 6:
      return { k: anyValue(next, depth + 1) };
    default:
      return Number.NaN;
  }
}

describe('PRO-081 criterion 2: a config key the component does not know is ignored (PRO-005)', () => {
  it('gives the same settings with or without unknown keys, over 300 generated configs', () => {
    const next = lcg(20261113);
    for (let i = 0; i < 300; i++) {
      const base: Record<string, unknown> = {};
      for (const key of KNOWN) if (next() < 0.5) base[key] = anyValue(next);
      const extra: Record<string, unknown> = { ...base };
      for (const name of UNKNOWN_NAMES) if (next() < 0.7) extra[name] = anyValue(next);
      expect(normaliseConfig(extra), `case ${i}`).toEqual(normaliseConfig(base));
    }
  });

  it('never reads an unknown key, even one that is an inherited property name', () => {
    const cfg = normaliseConfig({ constructor: 'x', toString: 'y', hasOwnProperty: 'z' });
    expect(cfg).toEqual(normaliseConfig(null));
    expect(Object.keys(cfg).sort()).toEqual(
      [
        'styleNonce',
        'graceMs',
        'pdfViewerUrl',
        'katexFontsUrl',
        'selectionShim',
        'footnoteModel',
        'deferRemoteWhileComposing',
        'forceStyleFallback',
        'pageGuides',
        'features',
      ].sort(),
    );
  });

  it('accepts any value for the object and yields the defaults for non-objects', () => {
    const defaults = normaliseConfig(null);
    for (const value of [undefined, null, 0, 'config', true, [1, 2], () => 1]) {
      expect(normaliseConfig(value)).toEqual(defaults);
    }
    expect(defaults.graceMs).toBe(DEFAULT_GRACE_MS);
    expect(defaults.styleNonce).toBeNull();
  });

  it('ignores a known key whose value has the wrong type and keeps the default', () => {
    const cfg: NormalConfig = normaliseConfig({
      styleNonce: 42,
      graceMs: -1,
      pdfViewerUrl: '',
      katexFontsUrl: '',
      selectionShim: 'other',
      footnoteModel: 'table',
      deferRemoteWhileComposing: 'no',
      forceStyleFallback: 1,
    });
    expect(cfg).toEqual(normaliseConfig(null));
  });
});

describe('PRO-081 criterion 3: the style nonce from config reaches the fallback style element', () => {
  it('keeps any non-empty nonce string unchanged', () => {
    const next = lcg(7);
    for (let i = 0; i < 100; i++) {
      const nonce = `n-${Math.floor(next() * 1e9).toString(36)}${i}`;
      expect(normaliseConfig({ styleNonce: nonce }).styleNonce).toBe(nonce);
    }
  });

  it('treats an empty nonce as absent, so no fallback element is given a nonce', () => {
    expect(normaliseConfig({ styleNonce: '' }).styleNonce).toBeNull();
  });

  it('passes config.styleNonce to the style path in the editor (src/editor.ts)', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'editor.ts'), 'utf8');
    expect(source).toMatch(/nonce:\s*config\.styleNonce/);
  });
});

/** The keys of `DocEditorConfig`, read from its declaration in src/config.ts. */
function declaredKeys(): string[] {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'config.ts'), 'utf8');
  const start = source.indexOf('export interface DocEditorConfig {');
  const end = source.indexOf('\n}', start);
  expect(start).toBeGreaterThanOrEqual(0);
  return [...source.slice(start, end).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
}

/**
 * Resolves a specifier the way a consumer of the package does: through Node.js's resolver and
 * the `exports` map of packages/element/package.json (a package may refer to itself by name).
 */
const consumer = createRequire(import.meta.url);

describe('PRO-081 criterion 1: the config type is published as TypeScript and as JSON Schema', () => {
  const schemaPath = consumer.resolve('@docedit/element/config.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    description: string;
    properties: Record<
      string,
      { type: string; description?: string; default?: unknown; enum?: unknown[] }
    >;
  };

  it('publishes the schema at @docedit/element/config.schema.json through the exports map', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { name: string; exports: Record<string, unknown> };
    expect(manifest.name).toBe('@docedit/element');
    expect(manifest.exports['./config.schema.json']).toBe('./src/config.schema.json');
    expect(schemaPath).toBe(join(import.meta.dirname, '..', 'src', 'config.schema.json'));
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
    });
    // The exports map is the gate: a path it does not list cannot be reached by a consumer.
    expect(() => consumer.resolve('@docedit/element/src/config.schema.json')).toThrow(
      /ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/,
    );
  });

  it('publishes the TypeScript type from the package entry point', () => {
    const entry = consumer.resolve('@docedit/element');
    expect(entry).toBe(join(import.meta.dirname, '..', 'src', 'index.ts'));
    expect(readFileSync(entry, 'utf8')).toMatch(
      /export type \{[^}]*\bDocEditorConfig\b[^}]*\} from '\.\/config\.ts';/,
    );
  });

  it('documents every key of DocEditorConfig in the schema, and the schema has no other key', () => {
    const keys = declaredKeys();
    expect(keys.length).toBe(KNOWN.length);
    expect(Object.keys(schema.properties).sort()).toEqual([...keys].sort());
    expect(new Set(keys)).toEqual(new Set(KNOWN));
    for (const key of keys) {
      expect(schema.properties[key]?.description, key).toMatch(/\S/);
    }
    expect(schema.description).toMatch(/PRO-081/);
  });

  it('gives each schema default the value the component uses when the key is absent', () => {
    const defaults = normaliseConfig(null) as unknown as Record<string, unknown>;
    for (const [key, prop] of Object.entries(schema.properties)) {
      if ('default' in prop) expect(defaults[key], key).toEqual(prop.default);
    }
  });

  it('gives each enum value and each type the component accepts (and rejects the others)', () => {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.enum) {
        for (const value of prop.enum)
          expect(normaliseConfig({ [key]: value })[key as keyof NormalConfig], key).toEqual(value);
        const bogus = normaliseConfig({ [key]: 'not-a-listed-value' });
        expect(bogus[key as keyof NormalConfig], key).toEqual(prop.default);
      }
      if (prop.type === 'boolean') {
        expect(normaliseConfig({ [key]: 'yes' })[key as keyof NormalConfig], key).toEqual(
          prop.default,
        );
      }
    }
  });
});
