// CDM-050 criterion 2: a commit the room stamps carries the `cdm` version and the engine that the
// package exposes for the stamp, and the identity adds the model package that validated it.
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { modelStampIdentity } from '@docedit/model/definition';
import { commitStampIdentity } from '../src/room/stamp.ts';
import { Room } from '../src/room/room.ts';
import { ENGINE } from '../src/room/types.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, schema } from './fixtures.ts';

describe('the identity on a commit stamp (CDM-050 criterion 2)', () => {
  it('exposes the cdm version, the engine and the model package identifier', () => {
    const id = commitStampIdentity();
    expect(id).toEqual({
      cdm: modelStampIdentity().cdm,
      engine: ENGINE,
      package: modelStampIdentity().package,
    });
    expect(id.package).toMatch(/^@docedit\/model@\d+\.\d+\.\d+/);
  });

  it('is what the room writes as cdm and engine on a stamped commit', () => {
    let clock = 1_790_000_000_000;
    const r = new Room({
      schema,
      initial: baseDoc(),
      requires: REQUIRES,
      log: [],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 1,
      incarnation: 'inc-1',
      now: () => ++clock,
    });
    r.open('c1', USERS.carol);
    const doc = baseDoc();
    const fx = r.snapshot('control', {
      id: '0192f0c4-7b1e-7000-8000-000000000b50',
      reason: 'migration',
      content: new Transform(doc).doc,
      checkpoint: 'ckpt-stamp',
      as: 'system',
    });
    const stamp = fx.write?.snapshot;
    expect(stamp).toBeDefined();
    const id = commitStampIdentity();
    expect(stamp?.cdm).toBe(id.cdm);
    expect(stamp?.engine).toBe(id.engine);
  });
});
