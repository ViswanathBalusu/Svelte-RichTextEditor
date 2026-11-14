/**
 * The editing schema loaded from the CDM (FE-030): generated from the definition in
 * packages/model, equal to the published artifacts apart from rendering, reading documents without
 * losing anything, and refusing what this build cannot read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalText, type JsonEnvelope } from '@docedit/model';
import { CDM1, supportedFeatures } from '@docedit/model/definition';
import { cdmSchema, projectionSchema } from '@docedit/model/prosemirror';
import type { Schema } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  CDM_VERSION,
  DocumentCore,
  ENGINE,
  UnsupportedDocumentError,
  capabilities,
} from '../src/headless.ts';
import { RENDERING_MEMBERS, editingSchema } from '../src/schema.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

const root = resolve(import.meta.dirname, '../../..');

/** A schema's nodes and marks as plain data, without the members rendering adds. */
function shape(schema: Schema): { nodes: Record<string, unknown>; marks: Record<string, unknown> } {
  const strip = (spec: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(spec).filter(([k, v]) => !RENDERING_MEMBERS.includes(k) && v !== undefined),
    );
  const nodes: Record<string, unknown> = {};
  schema.spec.nodes.forEach((name, spec) => {
    nodes[name] = strip(spec as Record<string, unknown>);
  });
  const marks: Record<string, unknown> = {};
  schema.spec.marks.forEach((name, spec) => {
    marks[name] = strip(spec as Record<string, unknown>);
  });
  return { nodes, marks };
}

describe('the editing schema comes from the CDM (FE-030)', () => {
  it('equals the model’s projection schema apart from rendering, and its CDM part the CDM schema', () => {
    const editing = shape(editingSchema());
    const projection = shape(projectionSchema());
    expect(editing).toEqual(projection);
    const cdm = shape(cdmSchema());
    const extra = Object.keys(editing.nodes).filter((n) => !(n in cdm.nodes));
    expect(extra).toEqual(['hidden_region']);
    for (const [name, spec] of Object.entries(cdm.nodes)) {
      if (name === 'body') continue; // its content also admits the placeholder (ADR 0019)
      expect(editing.nodes[name], name).toEqual(spec);
    }
    expect(editing.marks).toEqual(cdm.marks);
    expect(editingSchema().spec.topNode).toBe('doc');
    // Mark order is part of the canonical form (03 §2).
    expect(Object.keys(editing.marks)).toEqual(CDM1.marks.map((m) => m.name));
  });

  it('equals the published normative artifacts (spec/cdm), apart from rendering', () => {
    const file = resolve(root, 'spec/cdm/cdm-1.prosemirror.json');
    const artifact = JSON.parse(readFileSync(file, 'utf8')) as {
      nodes: Array<[string, Record<string, unknown>]>;
      marks: Array<[string, Record<string, unknown>]>;
    };
    const editing = shape(editingSchema());
    const cdm = shape(cdmSchema());
    // The runtime CDM schema is generated from the same data as the artifact.
    expect(Object.fromEntries(artifact.nodes)).toEqual(cdm.nodes);
    expect(Object.fromEntries(artifact.marks)).toEqual(editing.marks);
    const projectionFile = resolve(root, 'spec/cdm/cdm-1.projection.json');
    if (existsSync(projectionFile)) {
      const p = JSON.parse(readFileSync(projectionFile, 'utf8')) as {
        nodes: Array<[string, Record<string, unknown>]>;
      };
      expect(Object.fromEntries(p.nodes)).toEqual(editing.nodes);
    }
  });

  it('creates nodes that declare an id without a required attribute (ids default to null)', () => {
    const schema = editingSchema();
    for (const def of CDM1.nodes) {
      if (!('id' in def.attrs)) continue;
      expect(schema.nodes[def.name]!.spec.attrs!['id']!.default, def.name).toBeNull();
    }
    expect(schema.nodes['paragraph']!.createAndFill()?.attrs['id']).toBeNull();
    expect(schema.nodes['footnote']!.createAndFill()?.firstChild?.type.name).toBe('paragraph');
    expect(schema.nodes['region']!.createAndFill()?.attrs['id']).toBeNull();
  });

  it('keeps definitions and stories isolating, not node-selectable and closed to the gap cursor', () => {
    const schema = editingSchema();
    for (const name of ['defs', 'story']) {
      const spec = schema.nodes[name]!.spec;
      expect(spec.isolating, name).toBe(true);
      expect(spec.selectable, name).toBe(false);
      expect(spec.allowGapCursor, name).toBe(false);
    }
  });

  it('keeps ext content on nodes and marks through edits elsewhere', () => {
    const env = spikeDocument();
    const doc = structuredClone(env.doc) as {
      attrs?: Record<string, unknown>;
      content: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    doc.attrs = { ext: { 'x-host': { kept: true } } };
    const body = doc.content[doc.content.length - 1]!;
    const first = body.content![0] as {
      attrs: Record<string, unknown>;
      content: Array<Record<string, unknown>>;
    };
    first.attrs['ext'] = { 'x-host': { anchor: 'a1' } };
    first.content[0] = {
      type: 'text',
      text: 'Scope',
      marks: [{ type: 'bold', attrs: { value: true, ext: { 'x-host': { m: 1 } } } }],
    };
    const c = new DocumentCore({ doc: { ...env, doc }, schedule: microtask });
    const i = internals(c);
    const at = posOf(i.state.doc, SPIKE_IDS.last) + 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at)).insertText('edit '));
    const out = c.getContent().doc as typeof doc;
    expect(out.attrs?.['ext']).toEqual({ 'x-host': { kept: true } });
    const outFirst = out.content[out.content.length - 1]!.content![0] as typeof first;
    expect(outFirst.attrs['ext']).toEqual({ 'x-host': { anchor: 'a1' } });
    expect(
      (outFirst.content[0]!['marks'] as Array<{ attrs: Record<string, unknown> }>)[0]!.attrs['ext'],
    ).toEqual({ 'x-host': { m: 1 } });
  });

  it('refuses a document whose requires lists a feature this build lacks, or another CDM version', () => {
    const env = spikeDocument();
    expect(() => new DocumentCore({ doc: { ...env, requires: ['x-future'] } })).toThrow(
      UnsupportedDocumentError,
    );
    try {
      new DocumentCore({ doc: { ...env, requires: ['x-future', 'fields'] } });
    } catch (e) {
      expect((e as UnsupportedDocumentError).code).toBe('unsupported_feature');
      expect((e as UnsupportedDocumentError).missing).toEqual(['x-future']);
      expect((e as Error).message).toMatch(/does not support: x-future/);
    }
    try {
      new DocumentCore({ doc: { ...env, cdm: 2 } });
    } catch (e) {
      expect((e as UnsupportedDocumentError).code).toBe('unsupported_cdm');
    }
    expect(() => new DocumentCore({ doc: { ...env, cdm: 2 } })).toThrow(UnsupportedDocumentError);
  });

  it('reads a stored document back in the same canonical form without edits (hash fixtures)', () => {
    for (const name of ['example-03-12.json', 'kitchen-sink.json']) {
      const env = JSON.parse(
        readFileSync(resolve(root, 'packages/model/fixtures', name), 'utf8'),
      ) as JsonEnvelope;
      const c = new DocumentCore({ doc: env as never, schedule: microtask });
      expect(canonicalText(c.getContent() as unknown as JsonEnvelope), name).toBe(
        canonicalText(env),
      );
    }
  });

  it('uses the prosemirror-transform release the engine definition pins (pm-steps/1)', () => {
    const pin = JSON.parse(
      readFileSync(resolve(root, 'packages/authority/fixtures/engine/pm-steps-1.json'), 'utf8'),
    ) as {
      engine: string;
      library: { name: string; version: string };
      alsoPinned: Array<{ name: string; version: string }>;
    };
    const engine = JSON.parse(
      readFileSync(resolve(root, 'packages/engine/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const installed = (name: string) =>
      (
        JSON.parse(
          readFileSync(resolve(root, 'packages/engine/node_modules', name, 'package.json'), 'utf8'),
        ) as { version: string }
      ).version;
    expect(pin.engine).toBe(ENGINE);
    for (const lib of [pin.library, ...pin.alsoPinned]) {
      expect(engine.dependencies[lib.name], lib.name).toBe(lib.version);
      expect(installed(lib.name), lib.name).toBe(lib.version);
    }
  });

  it('announces the engine, the CDM version and the CDM features it supports (03 §11.1)', () => {
    expect(capabilities()).toEqual({
      engine: 'pm-steps/1',
      cdm: CDM_VERSION,
      features: supportedFeatures(CDM1),
    });
  });
});
