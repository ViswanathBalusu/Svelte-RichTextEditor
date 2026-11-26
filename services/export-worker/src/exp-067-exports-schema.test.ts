/**
 * EXP-067 criterion 1 (lane U-EXP-065-080): the exports resource accepts no raw LaTeX, preamble,
 * package or class. The check reads the published DEP OpenAPI document (spec/dep/dep-1.openapi.json,
 * generated, read only) and walks every schema that the export operations take or return.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const specPath = new URL('../../../spec/dep/dep-1.openapi.json', import.meta.url);

interface Schema {
  $ref?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  additionalProperties?: Schema | boolean;
}

interface OpenApi {
  paths: Record<
    string,
    Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>
  >;
  components: { schemas: Record<string, Schema> };
}

const api = JSON.parse(readFileSync(specPath, 'utf8')) as OpenApi;

/** Every schema name that the export operations reach, through $ref, properties and items. */
function reachable(): Set<string> {
  const names = new Set<string>();
  const visit = (s: Schema | boolean | undefined): void => {
    if (!s || typeof s === 'boolean') return;
    if (s.$ref) {
      const name = s.$ref.split('/').pop()!;
      if (names.has(name)) return;
      names.add(name);
      visit(api.components.schemas[name]);
      return;
    }
    for (const p of Object.values(s.properties ?? {})) visit(p);
    visit(s.items);
    for (const p of [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? [])]) visit(p);
    if (typeof s.additionalProperties === 'object') visit(s.additionalProperties);
  };
  for (const [path, ops] of Object.entries(api.paths)) {
    if (!/\/exports/.test(path)) continue;
    for (const op of Object.values(ops)) {
      for (const media of Object.values(op.requestBody?.content ?? {})) visit(media.schema);
    }
  }
  return names;
}

const FORBIDDEN = /latex|preamble|package|class|tex|lua|engine|shell/i;

describe('EXP-067 criterion 1: the exports resource has no input for raw LaTeX', () => {
  it('reaches the create-export request and its options', () => {
    const names = reachable();
    expect(names).toContain('CreateExportRequest');
    expect(names).toContain('ExportOptions');
  });

  it('has no property named for LaTeX, a preamble, a package, a class, an engine or a shell', () => {
    const names = reachable();
    const offending: string[] = [];
    for (const name of names) {
      const props = api.components.schemas[name]?.properties ?? {};
      for (const key of Object.keys(props))
        if (FORBIDDEN.test(key)) offending.push(`${name}.${key}`);
    }
    expect(offending).toEqual([]);
  });

  it('takes the export target and options only as the published schema names them', () => {
    const options = api.components.schemas['ExportOptions']?.properties ?? {};
    expect(Object.keys(options).sort()).toEqual(
      [
        'certificate',
        'comments',
        'fields',
        'layout',
        'locale',
        'pdfStandard',
        'profile',
        'suggestions',
        'tagging',
        'timeZone',
      ].sort(),
    );
    const request = api.components.schemas['CreateExportRequest']?.properties ?? {};
    expect(Object.keys(request).sort()).toEqual(['options', 'seq', 'target']);
  });
});
