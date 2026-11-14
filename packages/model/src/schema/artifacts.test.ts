// Published artifacts (CDM-006, CDM-007, CDM-008): byte-equal to a fresh generation, and the
// JSON Schema returns the expected verdicts in JavaScript (Ajv) and in Python (jsonschema).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { CDM1 } from '../definition/cdm1.ts';
import { checkDefinition } from './check-definition.ts';
import { generateArtifacts } from './artifacts.ts';
import { generateJsonSchema } from './json-schema.ts';

const root = resolve(import.meta.dirname, '../../../..');
const example = JSON.parse(
  readFileSync(resolve(root, 'packages/model/fixtures/example-03-12.json'), 'utf8'),
) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Negative cases, one per kind of failure CDM-007 names. */
function negatives(): Array<[string, unknown]> {
  const c = () => structuredClone(example);
  const para = (d: any) => d.doc.content[1].content[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const style = (d: any) => d.doc.content[0].content[1]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cases: Array<[string, unknown]> = [];
  let d = c();
  delete d.cdm;
  cases.push(['missing cdm', d]);
  d = c();
  d.doc.content[1].content.push({ type: 'comment', attrs: { id: 'cComment00000001' } });
  cases.push(['comment node', d]);
  d = c();
  para(d).content[0].marks = [{ type: 'comment', attrs: { thread: 'x' } }];
  cases.push(['comment mark', d]);
  d = c();
  d.title = 'Contract';
  cases.push(['extra envelope member', d]);
  d = c();
  style(d).attrs.fontSize = 220.5;
  cases.push(['non-integer number', d]);
  d = c();
  style(d).attrs.lineRule = 'double';
  cases.push(['enumeration', d]);
  d = c();
  style(d).attrs.outlineLevel = 10;
  cases.push(['range', d]);
  d = c();
  d.doc.content[1].content[1].attrs.title = 'x'.repeat(256);
  cases.push(['length', d]);
  d = c();
  style(d).attrs.color = '#12345g';
  cases.push(['pattern', d]);
  d = c();
  para(d).attrs.unknownAttribute = true;
  cases.push(['unknown attribute', d]);
  return cases;
}

describe('published artifacts', () => {
  it('has a complete definition', () => {
    expect(checkDefinition(CDM1)).toEqual([]);
  });

  it('match a fresh generation byte for byte', async () => {
    for (const a of await generateArtifacts(CDM1)) {
      const file = resolve(root, a.path);
      expect(existsSync(file), `${a.path} is missing; run pnpm generate`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${a.path} is stale; run pnpm generate`).toBe(a.text);
    }
  });

  it('names the cdm major version and its draft status', async () => {
    const schema = generateJsonSchema(CDM1);
    expect(schema['$id']).toBe('urn:docedit:cdm:1:draft');
    const description = String(schema['description']);
    expect(description).toMatch(/model\.validate\(\)/);
    // The invariants JSON Schema cannot express are listed (CDM-007).
    for (const id of [
      'I1 in part',
      'I2',
      'I3',
      'I4',
      'I5',
      'I6',
      'I7 in part',
      'I8',
      'I10 in part',
    ])
      expect(description, id).toContain(`- ${id}`);
    // Until the footnote model (CDM-001) and the grammars (CDM-002) are recorded, every artifact is
    // published as a draft, never as the frozen `cdm: 1`.
    const manifest = (await generateArtifacts(CDM1)).find((a) => a.path.endsWith('manifest.json'))!;
    const parsed = JSON.parse(manifest.text) as { status: string; files: Record<string, string> };
    expect(parsed.status).toBe('draft');
    expect(Object.keys(parsed.files)).toEqual(
      expect.arrayContaining([
        'spec/cdm/cdm-1.schema.json',
        'spec/cdm/cdm-1.prosemirror.json',
        'spec/cdm/cdm-1.attributes.md',
      ]),
    );
    expect(schema['title']).toBe('CDM version 1 (draft)');
  });

  it('JSON Schema accepts the example and rejects each negative case (Ajv)', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: false, unicodeRegExp: true });
    const validate = ajv.compile(generateJsonSchema(CDM1));
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    for (const [name, doc] of negatives()) expect(validate(doc), name).toBe(false);
  });

  it('gives the same verdicts in Python jsonschema', (ctx) => {
    let python = '';
    for (const cmd of ['python', 'python3']) {
      try {
        execFileSync(cmd, ['-c', 'import jsonschema'], { stdio: 'ignore' });
        python = cmd;
        break;
      } catch {
        /* try the next one */
      }
    }
    if (!python) return ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), 'cdm-schema-'));
    const schemaFile = join(dir, 'schema.json');
    const casesFile = join(dir, 'cases.json');
    writeFileSync(schemaFile, JSON.stringify(generateJsonSchema(CDM1)));
    writeFileSync(casesFile, JSON.stringify([['example', example], ...negatives()]));
    const script = [
      'import json, sys',
      'from jsonschema import Draft202012Validator',
      'schema = json.load(open(sys.argv[1], encoding="utf-8"))',
      'cases = json.load(open(sys.argv[2], encoding="utf-8"))',
      'v = Draft202012Validator(schema)',
      'print(json.dumps({name: v.is_valid(doc) for name, doc in cases}))',
    ].join('\n');
    const out = JSON.parse(
      execFileSync(python, ['-I', '-c', script, schemaFile, casesFile], { encoding: 'utf8' }),
    ) as Record<string, boolean>;
    expect(out['example']).toBe(true);
    for (const [name] of negatives()) expect(out[name], name).toBe(false);
    // Two synchronous Python starts; a loaded machine takes about 40 s for the import alone.
  }, 240_000);
});
