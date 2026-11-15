// The backend port typings (PRO-091, PRO-092): aliases of the generated DEP types, no ProseMirror
// type in any port, every core member exercised by the contract suite, errors that carry the
// registry's codes.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CORE_MEMBERS,
  OPTIONAL_MEMBERS,
  portContract,
  uncoveredMembers,
} from '../src/contract/index.ts';
import type { UnlistedOptionalMembers } from '../src/contract/optional.ts';
import type * as W from '../src/generated/types.ts';
import {
  OPTIONAL_PORTS,
  PORT_FEATURES,
  hasPort,
  portFeatureMismatches,
} from '../src/ports/features.ts';
import { PortError, SyncRejectError, isSyncReject } from '../src/ports/errors.ts';
import type { Backend } from '../src/ports/core.ts';
import type {
  Access,
  Ack,
  ChannelOpened,
  Commit,
  Content,
  Notification,
  RemoteCommit,
  Resume,
  SyncReject,
} from '../src/ports/types.ts';
import { ajv2020, readJson, readText } from './support.ts';

const sources = (dir: string) =>
  readdirSync(resolve(import.meta.dirname, '..', dir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => `packages/protocol/${dir}/${f}`);

describe('the port typings', () => {
  it('are the generated wire types, so they cannot differ from the artifacts (PRO-091)', () => {
    expectTypeOf<Commit>().toEqualTypeOf<W.Commit>();
    expectTypeOf<Ack>().toEqualTypeOf<W.Ack>();
    expectTypeOf<SyncReject>().toEqualTypeOf<W.SyncReject>();
    expectTypeOf<RemoteCommit>().toEqualTypeOf<W.RemoteCommit>();
    expectTypeOf<Access>().toEqualTypeOf<W.Access>();
    expectTypeOf<Notification>().toEqualTypeOf<W.Notification>();
    expectTypeOf<Resume>().toEqualTypeOf<W.Resume>();
    expectTypeOf<ChannelOpened>().toEqualTypeOf<W.ChannelOpened>();
    expectTypeOf<Content>().toEqualTypeOf<W.Content>();
  });

  it('use no ProseMirror type in any port or generated type (PRO-091)', () => {
    for (const file of [
      ...sources('src/ports'),
      ...sources('src/contract'),
      'packages/protocol/src/generated/types.ts',
    ]) {
      const text = readText(file);
      expect(
        /from\s+['"]prosemirror-|import\(\s*['"]prosemirror-/.test(text),
        `${file} imports ProseMirror`,
      ).toBe(false);
      expect(
        /\b(EditorState|Transaction|Fragment|Slice|ResolvedPos|Mark|Schema|StepMap|Mapping)\b/.test(
          text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
        ),
        `${file} names a ProseMirror class`,
      ).toBe(false);
    }
  });

  it('have core ports with the members 05 §8.3 names, and every optional port of 05 §8.3', () => {
    const core = readText('packages/protocol/src/ports/core.ts');
    for (const m of [
      'features',
      'connect()',
      'close()',
      'auth',
      'sync',
      'permissions',
      'loadContent(',
      'open(',
      'submit(',
      'onCommits(',
      'onReset(',
      'onAccess(',
      'onEvent(',
      'onState(',
    ])
      expect(core, m).toContain(m);
    expect([...OPTIONAL_PORTS]).toEqual([
      'presence',
      'history',
      'comments',
      'assets',
      'exports',
      'imports',
      'fonts',
      'leases',
      'fields',
      'workflow',
      'proofing',
      'assistant',
    ]);
    for (const p of OPTIONAL_PORTS) expect(core, p).toMatch(new RegExp(`readonly ${p}\\?:`));
    expect(Object.keys(OPTIONAL_MEMBERS)).toEqual([...OPTIONAL_PORTS]);
  });

  it('have at least one contract case for every member of the core ports', () => {
    const cases = portContract(
      async () => {
        throw new Error('not run');
      },
      { sleep: async () => {} },
    );
    const uncovered = uncoveredMembers(cases);
    expect(uncovered.filter((m) => CORE_MEMBERS.includes(m))).toEqual([]);
  });

  it('list every member of every optional port, each with a contract case (PRO-092)', () => {
    // The list is checked against the typings: a member missing from it is a type error.
    expectTypeOf<UnlistedOptionalMembers>().toBeNever();
    const cases = portContract(
      async () => {
        throw new Error('not run');
      },
      { sleep: async () => {} },
    );
    expect(uncoveredMembers(cases)).toEqual([]);
    for (const [port, members] of Object.entries(OPTIONAL_MEMBERS)) {
      expect(members.length, port).toBeGreaterThan(0);
      for (const m of members) {
        const own = cases.filter((k) => k.port === port && k.members.includes(`${port}.${m}`));
        expect(own.length, `${port}.${m}`).toBeGreaterThan(0);
      }
    }
  });

  it('answer "is this feature available" from the port and the announced feature (PRO-092)', () => {
    const backend = {
      features: new Set(['presence']),
      presence: {},
      fonts: {},
    } as unknown as Backend;
    expect(hasPort(backend, 'presence')).toBe(true);
    expect(hasPort(backend, 'fonts')).toBe(true); // no feature name exists for fonts (G06)
    expect(hasPort(backend, 'history')).toBe(false);
    const announcedOnly = { features: new Set(['history']) } as unknown as Backend;
    expect(hasPort(announcedOnly, 'history')).toBe(false);
    expect(portFeatureMismatches(announcedOnly)).toEqual([
      'feature history is announced but port history is absent',
    ]);
    for (const p of OPTIONAL_PORTS) {
      const f = PORT_FEATURES[p];
      if (f)
        expect(
          readJson<{ features: Array<{ name: string }> }>(
            'spec/dep/dep-1.registry.json',
          ).features.map((x) => x.name),
        ).toContain(f);
    }
  });
});

describe('the port errors', () => {
  const ajv = ajv2020();
  ajv.addSchema(readJson('spec/dep/dep-1.schema.json'));
  const rejectSchema = ajv.getSchema('urn:docedit:dep:1:draft#/$defs/SyncReject')!;

  it('SyncRejectError is an Error whose members are the sync.reject payload (D22)', () => {
    const payload: SyncReject = {
      id: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
      code: 'permission_denied',
      message: 'No edit permission',
      action: 'drop',
      head: 417,
      scopes: ['region:rG7mK2pQ9xYt4HcD'],
    };
    const e = new SyncRejectError(payload);
    expect(e).toBeInstanceOf(Error);
    expect(isSyncReject(e)).toBe(true);
    expect(e.toJSON()).toEqual(payload);
    expect(rejectSchema(e.toJSON())).toBe(true);
    expectTypeOf(e).toMatchTypeOf<SyncReject>();
  });

  it('PortError carries a registry code', () => {
    const e = new PortError('not_found', 'no document', { retryAfterMs: 5 });
    expect([e.code, e.retryAfterMs, e.message]).toEqual(['not_found', 5, 'no document']);
    expectTypeOf(e.code).toEqualTypeOf<W.ErrorCode>();
  });
});
