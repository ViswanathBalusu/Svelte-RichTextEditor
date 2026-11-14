// Reading a document (03 §2, §11.1; CDM-009): refuse what the reader cannot fully understand,
// check `requires` before ProseMirror parses anything, and read and write without loss.
import { describe, expect, it, vi } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '../../fixtures/kitchen-sink.json' with { type: 'json' };
import { canonicalText, type JsonEnvelope } from '../canonical/canonical-form.ts';
import { buildSchema } from '../prosemirror/index.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { readDocument, supportedVersions, writeDocument } from './read.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ASSETS = new Set([
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a12',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a13',
]);

describe('readDocument (CDM-009)', () => {
  it('refuses an unknown feature with unsupported_feature, naming each one, and returns no document', () => {
    const env = { ...structuredClone(example), requires: ['fields', 'tables3d', 'holograms'] };
    const r = readDocument(env);
    expect(r).toMatchObject({
      ok: false,
      code: 'unsupported_feature',
      missing: ['tables3d', 'holograms'],
    });
    expect(r.ok === false && r.message).toMatch(/tables3d, holograms/);
    expect('doc' in r).toBe(false);
  });

  it('checks requires before the ProseMirror parser is called', () => {
    const schema = buildSchema(CDM1);
    const parse = vi.spyOn(schema, 'nodeFromJSON');
    const env = { ...structuredClone(example), requires: ['tables3d'] };
    expect(readDocument(env, { schema })).toMatchObject({ code: 'unsupported_feature' });
    expect(parse).not.toHaveBeenCalled();
    // The same envelope with known features is parsed.
    expect(readDocument(example, { schema }).ok).toBe(true);
    expect(parse).toHaveBeenCalled();
  });

  it('a reader without `preserve` refuses a document that needs it (CDM-051)', () => {
    const r = readDocument(kitchenSink, {
      features: ['fields', 'extensions'],
      attachedAssets: ASSETS,
    });
    expect(r).toMatchObject({ ok: false, code: 'unsupported_feature', missing: ['preserve'] });
  });

  it('refuses a newer major version with unsupported_cdm, naming both versions', () => {
    expect(supportedVersions()).toEqual({ min: 1, max: 1 });
    const r = readDocument({ ...structuredClone(example), cdm: 2 });
    expect(r).toMatchObject({ ok: false, code: 'unsupported_cdm', version: 2 });
    expect(r.ok === false && r.message).toMatch(/version 2.*version 1/);
  });

  it('reports I1 for a node of a feature that requires omits, instead of dropping it', () => {
    const env = structuredClone(example) as Json;
    env['doc'].content[1].content[0].content.push({
      type: 'form_field',
      attrs: { id: 'fFieldNode000001', key: 'a', label: 'A' },
    });
    const r = readDocument(env);
    expect(r.ok).toBe(false);
    if (r.ok || r.code !== 'validation_failed') throw new Error('expected a validation failure');
    expect(
      r.violations.some((v) => v.invariant === 'I1' && /feature "fields"/.test(v.message)),
    ).toBe(true);
  });

  it('refuses an envelope with metadata', () => {
    for (const key of ['title', 'owner', 'createdAt', 'anything']) {
      const r = readDocument({ ...structuredClone(example), [key]: 'x' });
      expect(r, key).toMatchObject({ ok: false, code: 'validation_failed' });
    }
  });

  it('reads and writes back to the same canonical form', () => {
    for (const [name, env, ctx] of [
      ['example', example, {}],
      ['kitchen sink', kitchenSink, { attachedAssets: ASSETS }],
    ] as const) {
      const r = readDocument(env, ctx);
      if (!r.ok) throw new Error(`${name}: ${r.message}`);
      const back = writeDocument(r.doc, r.requires);
      expect(canonicalText(back), name).toBe(canonicalText(env as JsonEnvelope));
    }
  });
});
