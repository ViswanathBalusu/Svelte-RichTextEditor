/**
 * Builds example values from definition shapes: `min` holds only required members, `max` every
 * member. Tests use them to check that the published JSON Schema and the run-time validator give
 * the same verdicts on every message, payload and body, and that unknown members are allowed.
 */
import type { CdmEnvelope } from '@docedit/model';
import type { DepDefinition } from '../definition/extension.ts';
import type { MessageDef } from '../definition/messages.ts';
import type { Shape, StringShape } from '../definition/shapes.ts';

export type Mode = 'min' | 'max';

const FORMAT_EXAMPLE: Record<NonNullable<StringShape['format']>, string> = {
  uuid7: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  timestamp: '2026-09-18T10:42:00.000Z',
  nodeId: 'rG7mK2pQ9xYt4HcD',
  scope: 'region:rG7mK2pQ9xYt4HcD',
  uri: 'https://docs.example.com/v1',
  'uri-reference': '/documents/0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  sha256: '9c1f'.repeat(16),
  version: '1.0',
  name: 'presence',
  language: 'en-GB',
};

export class ExampleBuilder {
  private readonly named: ReadonlyMap<string, Shape>;
  private readonly cdm: CdmEnvelope;

  constructor(def: DepDefinition, cdm: CdmEnvelope) {
    this.named = new Map(def.shapes.map((s) => [s.name, s.shape]));
    this.cdm = cdm;
  }

  build(shape: Shape, mode: Mode, depth = 0): unknown {
    if (depth > 24) throw new Error('example nesting too deep');
    switch (shape.kind) {
      case 'string':
        return this.string(shape);
      case 'integer':
        return Math.min(Math.max(shape.min ?? 0, 0), shape.max ?? Number.MAX_SAFE_INTEGER);
      case 'boolean':
        return true;
      case 'const':
        return shape.value;
      case 'array': {
        const n = mode === 'min' ? (shape.minItems ?? 0) : Math.max(1, shape.minItems ?? 0);
        return Array.from({ length: n }, () => this.build(shape.items, mode, depth + 1));
      }
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const [k, p] of Object.entries(shape.props))
          if (p.required === true || mode === 'max') out[k] = this.build(p.shape, mode, depth + 1);
        for (const [k, p] of Object.entries(shape.props))
          if (
            typeof p.required === 'object' &&
            !(k in out) &&
            out[p.required.if.prop] === p.required.if.equals
          )
            out[k] = this.build(p.shape, mode, depth + 1);
        return out;
      }
      case 'map':
        if (mode === 'min') return {};
        return {
          [shape.keys ? this.string(shape.keys) : 'key']: this.build(shape.values, mode, depth + 1),
        };
      case 'ref': {
        const target = this.named.get(shape.name);
        if (!target) throw new Error(`unknown shape ${shape.name}`);
        return this.build(target, mode, depth + 1);
      }
      case 'anyOf':
        return this.build(shape.of[0]!, mode, depth + 1);
      case 'nullable':
        return mode === 'min' ? null : this.build(shape.of, mode, depth + 1);
      case 'any':
        return 'any';
      case 'external':
        return JSON.parse(
          JSON.stringify(shape.target === 'cdm-doc' ? this.cdm.doc : this.cdm),
        ) as unknown;
    }
  }

  private string(s: StringShape): string {
    if (s.enum) return s.enum[0]!;
    if (s.known) return s.known[0]!;
    if (s.format) return FORMAT_EXAMPLE[s.format];
    if (s.pattern) {
      const re = new RegExp(s.pattern, 'u');
      const found = ['everyone', 'x', 'a1', '2026-01'].find((c) => re.test(c));
      if (!found) throw new Error(`no example for pattern ${s.pattern}`);
      return found;
    }
    return 'x'.repeat(Math.max(1, s.minLength ?? 1));
  }

  /** An envelope of a message type, with its payload. */
  message(m: MessageDef, mode: Mode): Record<string, unknown> {
    const out: Record<string, unknown> = { t: m.t };
    if (m.id === 'required' || mode === 'max') out['id'] = 'm1';
    if (m.re === 'required' || (mode === 'max' && m.re !== 'none')) out['re'] = 'm0';
    if (m.ch === 'required' || (mode === 'max' && m.ch !== 'none')) out['ch'] = 1;
    if (m.payload) out['d'] = this.build(m.payload, mode);
    return out;
  }
}
