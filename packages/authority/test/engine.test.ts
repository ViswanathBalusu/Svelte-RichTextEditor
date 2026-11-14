// Engine `pm-steps/1` (04 §4; SYN-002): the engine definition names the exact prosemirror-transform
// release and the generated schema; the golden fixtures for apply, map and rebase replay exactly.
// A dependency update that changes any output fails here unless the engine identifier changes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalize, canonicalNode, sha256Hex, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Node } from 'prosemirror-model';
import { Mapping, Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { applySteps, mapsOf, rebaseOver } from '../src/rebase.ts';
import { ENGINE } from '../src/room/types.ts';
import { ALLOWED_STEP_TYPES } from '../src/steps.ts';
import {
  buildEngineFiles,
  ENGINE_DIR,
  installedVersion,
  ROOT,
} from '../scripts/engine-fixtures.ts';

/**
 * An engine identifier is bound to one release for good. Changing this line is the "new engine
 * identifier, not a silent upgrade" of 04 §4.
 */
const RELEASE_OF: Readonly<Record<string, string>> = { 'pm-steps/1': '1.12.5' };

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const read = (path: string): J =>
  JSON.parse(readFileSync(resolve(ROOT, ENGINE_DIR, path), 'utf8')) as J;
const engine = read('pm-steps-1.json');
const golden = {
  apply: read(engine['fixtures'].apply),
  map: read(engine['fixtures'].map),
  rebase: read(engine['fixtures'].rebase),
};
const schema = cdmSchema();
const steps = (json: unknown[]): Step[] => json.map((s) => Step.fromJSON(schema, s));
const docOf = (file: J, name: string): Node => schema.nodeFromJSON(file['docs'][name]);
const hash = (doc: Node) => sha256Hex(canonicalize(canonicalNode(doc.toJSON() as JsonNode)));

describe('engine pm-steps/1 (SYN-002)', () => {
  it('names the exact release; it is installed and is the only one the lock file resolves', () => {
    expect(engine['engine']).toBe('pm-steps/1');
    expect(ENGINE, 'the room stamps commits with this engine').toBe(engine['engine']);
    expect(engine['library']).toEqual({
      name: 'prosemirror-transform',
      version: RELEASE_OF[engine['engine']],
    });
    expect(installedVersion('prosemirror-transform')).toBe(engine['library'].version);
    for (const pin of engine['alsoPinned'] as Array<{ name: 'prosemirror-model'; version: string }>)
      expect(installedVersion(pin.name), pin.name).toBe(pin.version);
    const lock = readFileSync(resolve(ROOT, 'pnpm-lock.yaml'), 'utf8');
    for (const name of ['prosemirror-transform', ...engine['alsoPinned'].map((p: J) => p.name)]) {
      const versions = new Set(
        [...lock.matchAll(new RegExp(`\\b${name}@(\\d+\\.\\d+\\.\\d+[^:'\\s(]*)`, 'g'))].map(
          (m) => m[1],
        ),
      );
      const pinned =
        name === 'prosemirror-transform'
          ? engine['library'].version
          : engine['alsoPinned'].find((p: J) => p.name === name).version;
      expect([...versions], name).toEqual([pinned]);
    }
    expect(engine['stepTypes']).toEqual([...ALLOWED_STEP_TYPES]);
  });

  it('names the version of the generated schema the steps apply against', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(ROOT, 'spec/cdm/cdm-1.manifest.json'), 'utf8'),
    ) as J;
    const artifact = JSON.parse(readFileSync(resolve(ROOT, engine['schema'].artifact), 'utf8'));
    expect(engine['schema'].sha256).toBe(manifest['prosemirrorSchemaHash']);
    expect(await sha256Hex(canonicalize(artifact))).toBe(engine['schema'].sha256);
    for (const [kind, file] of Object.entries(golden)) {
      expect(file['engine'], kind).toBe(engine['engine']);
      expect(file['schema'].sha256, kind).toBe(engine['schema'].sha256);
      expect(file['library']['prosemirror-transform'], kind).toBe(engine['library'].version);
    }
  });

  it('replays every apply fixture', async () => {
    expect(golden.apply['cases'].length).toBeGreaterThan(20);
    for (const c of golden.apply['cases'] as J[]) {
      const r = applySteps(docOf(golden.apply, c['doc']), steps(c['steps']));
      if (c['expected'].ok) {
        expect(r.ok, c['id']).toBe(true);
        if (!r.ok) continue;
        expect(canonicalNode(r.value.doc.toJSON() as JsonNode), c['id']).toEqual(c['expected'].doc);
        expect(await hash(r.value.doc), c['id']).toBe(c['expected'].docSha256);
      } else {
        expect(r.ok, c['id']).toBe(false);
        if (!r.ok)
          expect(r.reason, c['id']).toMatch(new RegExp(`^step ${c['expected'].failedStep}\\b`));
      }
    }
  });

  it('replays every map fixture', () => {
    expect(golden.map['cases'].length).toBeGreaterThan(10);
    for (const c of golden.map['cases'] as J[]) {
      const mapping = new Mapping(mapsOf(steps(c['steps'])));
      const actual = (c['positions'] as Array<{ pos: number; assoc: number }>).map(
        ({ pos, assoc }) => {
          const r = mapping.mapResult(pos, assoc);
          return {
            pos: r.pos,
            deleted: r.deleted,
            deletedBefore: r.deletedBefore,
            deletedAfter: r.deletedAfter,
            deletedAcross: r.deletedAcross,
          };
        },
      );
      expect(actual, c['id']).toEqual(c['expected']);
    }
  });

  it('replays every rebase fixture, in the authority (reject) and client (drop) modes', async () => {
    const cases = golden.rebase['cases'] as J[];
    expect(cases.length).toBeGreaterThan(30);
    expect(cases.filter((c) => c['expected'].drop.dropped.length).length).toBeGreaterThan(5);
    for (const c of cases) {
      const base = docOf(golden.rebase, c['doc']);
      const over = steps(c['over']);
      const head = applySteps(base, over);
      if (!head.ok) throw new Error(`${c['id']}: ${head.reason}`);
      const own = steps(c['steps']);
      const reject = rebaseOver(own, mapsOf(over), head.value.doc, 'reject');
      const exp = c['expected'];
      if (exp.reject.ok) {
        expect(reject.ok, c['id']).toBe(true);
        if (reject.ok) {
          expect(
            reject.value.steps.map((s) => s.toJSON()),
            c['id'],
          ).toEqual(exp.reject.steps);
          expect(await hash(reject.value.doc), c['id']).toBe(exp.reject.docSha256);
        }
      } else {
        expect(reject, c['id']).toMatchObject({ ok: false, code: 'rebase_failed' });
        if (!reject.ok)
          expect(reject.reason, c['id']).toMatch(new RegExp(`^step ${exp.reject.failedStep}\\b`));
      }
      const drop = rebaseOver(own, mapsOf(over), head.value.doc, 'drop');
      if (!drop.ok) throw new Error('drop mode never fails');
      expect(
        drop.value.steps.map((s) => s.toJSON()),
        c['id'],
      ).toEqual(exp.drop.steps);
      expect(drop.value.dropped, c['id']).toEqual(exp.drop.dropped);
      expect(await hash(drop.value.doc), c['id']).toBe(exp.drop.docSha256);
    }
  });

  it('covers all seven step types in the fixtures', () => {
    const seen = new Set<string>();
    for (const file of Object.values(golden))
      for (const c of file['cases'] as J[])
        for (const s of [...(c['steps'] ?? []), ...(c['over'] ?? [])]) seen.add(s.stepType);
    expect([...seen].sort()).toEqual([...ALLOWED_STEP_TYPES].sort());
  });

  it('is current: a fresh generation from the pinned release writes the same bytes', async () => {
    for (const f of await buildEngineFiles())
      expect(
        readFileSync(resolve(ROOT, f.path), 'utf8'),
        `${f.path} is stale; run pnpm generate`,
      ).toBe(f.text);
  });
});
