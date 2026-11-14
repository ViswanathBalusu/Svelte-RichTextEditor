// The canonical-form hash fixtures (CDM-011): language-neutral files that cover every node, mark
// and field kind and every canonical rule, checked here against the TypeScript implementation and
// against an independent implementation in Python (conformance/canonical.py).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULES } from '../../scripts/canonical-fixtures.ts';
import { CDM1, FIELD_NODE_KINDS } from '../definition/cdm1.ts';
import { validate } from '../validate/validate.ts';
import {
  CANONICAL_FORM_VERSION,
  canonicalNodeText,
  canonicalText,
  type JsonEnvelope,
  type JsonNode,
} from './canonical-form.ts';

const root = resolve(import.meta.dirname, '../../../..');
const dir = resolve(root, 'packages/model/fixtures/canonical');
interface Case {
  name: string;
  kind: 'envelope' | 'node';
  rules: string[];
  input: string;
  expected: string;
  sha256: string;
  assets?: string[];
}
const index = JSON.parse(readFileSync(resolve(dir, 'index.json'), 'utf8')) as {
  canonicalFormVersion: number;
  cases: Case[];
};
const read = (file: string) => readFileSync(resolve(dir, file), 'utf8');
const input = (c: Case) => JSON.parse(read(c.input)) as JsonEnvelope & JsonNode;

function used(node: JsonNode, out: { nodes: Set<string>; marks: Set<string>; kinds: Set<string> }) {
  out.nodes.add(node.type);
  for (const m of node.marks ?? []) out.marks.add(m.type);
  if (node.type === 'field') out.kinds.add(String(node.attrs?.['kind'] ?? 'page'));
  for (const c of node.content ?? []) used(c, out);
  return out;
}

describe('canonical-form fixtures (CDM-011)', () => {
  it('use every node type, mark and field kind of CDM 1 in one valid document', () => {
    const all = index.cases.find((c) => c.name === 'all-constructs')!;
    const doc = input(all);
    expect(validate(doc, { attachedAssets: new Set(all.assets) }).violations).toEqual([]);
    const seen = used(doc.doc, { nodes: new Set(), marks: new Set(), kinds: new Set() });
    expect([...seen.nodes].sort()).toEqual(CDM1.nodes.map((n) => n.name).sort());
    expect([...seen.marks].sort()).toEqual(CDM1.marks.map((m) => m.name).sort());
    expect([...seen.kinds].sort()).toEqual([...FIELD_NODE_KINDS].sort());
  });

  it('give each canonical rule at least one input and expected-output pair', () => {
    for (const rule of Object.keys(RULES))
      expect(
        index.cases.some((c) => c.rules.includes(rule)),
        rule,
      ).toBe(true);
  });

  it('store the canonical bytes and their SHA-256, which the implementation reproduces', () => {
    for (const c of index.cases) {
      const text = c.kind === 'envelope' ? canonicalText(input(c)) : canonicalNodeText(input(c));
      const expected = read(c.expected);
      expect(text, c.name).toBe(expected);
      expect(createHash('sha256').update(Buffer.from(expected, 'utf8')).digest('hex'), c.name).toBe(
        c.sha256,
      );
    }
  });

  it('cannot change under the same canonical-form version: the version is declared with the fixtures', () => {
    // A change of the rules makes the comparison above fail; the generator then refuses to write new
    // expected outputs until CANONICAL_FORM_VERSION is raised (scripts/canonical-fixtures.ts).
    expect(index.canonicalFormVersion).toBe(CANONICAL_FORM_VERSION);
  });

  it('give the same bytes in an independent Python implementation', (ctx) => {
    let python = '';
    for (const cmd of ['python', 'python3']) {
      try {
        execFileSync(cmd, ['--version'], { stdio: 'ignore' });
        python = cmd;
        break;
      } catch {
        /* try the next one */
      }
    }
    if (!python) return ctx.skip();
    const out = JSON.parse(
      execFileSync(
        python,
        [
          '-I',
          resolve(root, 'packages/model/conformance/canonical.py'),
          resolve(root, 'spec/cdm/cdm-1.prosemirror.json'),
          resolve(dir, 'index.json'),
        ],
        { encoding: 'utf8' },
      ),
    ) as Record<string, { bytes: boolean; sha256: boolean }>;
    expect(Object.keys(out).sort()).toEqual(index.cases.map((c) => c.name).sort());
    for (const [name, r] of Object.entries(out))
      expect(r, name).toEqual({ bytes: true, sha256: true });
  });
});
