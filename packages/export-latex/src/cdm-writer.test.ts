/**
 * EXP-086 (Node.js only): the canonical JSON export target. Criteria covered here: 1 (the output is
 * the envelope in the canonical form, byte for byte as the fixtures of CDM-011 give it), 2 (its
 * SHA-256 equals the hash the independent conformance kit gives for the same document), and 3 (no
 * comments, grants or history are in the output, even when the envelope carries them). Criterion
 * 4 (the job's states, events, permission and `no-export` rules) belongs to the export service, not
 * to this package, and is not covered here. The fixtures are read from `packages/model/fixtures`
 * (read only); nothing here compiles.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '@docedit/model';
import { cdmWriter } from './writer.ts';

const FIXTURES = new URL('../../model/fixtures/canonical/', import.meta.url);

interface Case {
  name: string;
  kind: 'envelope' | 'node';
  input: string;
  expected: string;
  sha256: string;
}
const index = JSON.parse(readFileSync(new URL('index.json', FIXTURES), 'utf8')) as {
  canonicalFormVersion: number;
  cases: Case[];
};
const envelopes = index.cases.filter((c) => c.kind === 'envelope');
const read = (file: string): string => readFileSync(new URL(file, FIXTURES), 'utf8');

describe('EXP-086 criteria 1 and 2: the envelope in canonical form, with the conformance kit hash', () => {
  it('has envelope fixtures to check', () => {
    expect(envelopes.length).toBeGreaterThanOrEqual(5);
  });

  for (const c of envelopes) {
    it(`writes the canonical text and hash of fixture "${c.name}"`, async () => {
      const env = JSON.parse(read(c.input)) as CdmEnvelope;
      const out = await cdmWriter.write(
        { document: env, seq: null, chainHead: null, fonts: undefined as never, assets: {} },
        {},
      );
      expect(out.text).toBe(read(c.expected).replace(/\n$/, ''));
      expect(out.sha256).toBe(c.sha256);
      expect(new TextDecoder().decode(out.bytes)).toBe(out.text);
    });
  }
});

describe('EXP-086 criterion 3: no comments, grants or history in the output', () => {
  it('drops comments, grants and history that an envelope carries, and keeps cdm, requires and doc', async () => {
    const base = JSON.parse(read(envelopes[0]!.input)) as Record<string, unknown>;
    const carrying = {
      ...base,
      comments: [{ id: 'c1', text: 'a comment' }],
      grants: [{ role: 'editor', user: 'someone' }],
      history: [{ seq: 1, event: 'created' }],
    } as unknown as CdmEnvelope;
    const out = await cdmWriter.write(
      { document: carrying, seq: 1, chainHead: null, fonts: undefined as never, assets: {} },
      {},
    );
    const parsed = JSON.parse(out.text) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['cdm', 'doc', 'requires']);
    expect(out.text).not.toContain('a comment');
    expect(out.text).not.toContain('someone');
    expect(out.text).not.toContain('"history"');
  });

  it('gives the same output with or without the extra members, so they never change the hash', async () => {
    const base = JSON.parse(read(envelopes[0]!.input)) as CdmEnvelope;
    const plain = await cdmWriter.write(
      { document: base, seq: null, chainHead: null, fonts: undefined as never, assets: {} },
      {},
    );
    const extra = await cdmWriter.write(
      {
        document: { ...base, comments: [{ id: 'x' }] } as unknown as CdmEnvelope,
        seq: null,
        chainHead: null,
        fonts: undefined as never,
        assets: {},
      },
      {},
    );
    expect(extra.sha256).toBe(plain.sha256);
  });
});
