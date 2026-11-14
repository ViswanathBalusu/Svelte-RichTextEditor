// PRM-043 (a refused lease leaves the held lease as it was) and PRM-050 (a restore that needs a
// missing style recreates it for a user with `structure`, and the stored document has it). The
// rest of these stories is tested in leases-states.test.ts.
import type { Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import { acquireLease } from '../src/permissions/leases.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { planRestoreDefinitions } from '../src/permissions/restore.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, USERS, baseDoc, basePermissions, posOf, schema } from './fixtures.ts';
import { commitId, messages, morePermissions, roomWith } from './permission-fixtures.ts';

const TERMS = 'rTerms000000000A';
const NOW = 1_770_700_000_000;
const access = (conn: Connection, perms: PermissionState, doc = baseDoc(), now = NOW) =>
  computeAccess(conn, regionInfos(doc), perms, now);

/** The base document with a style `Clause` that the Terms paragraph uses; `Clause` is defined. */
const withClause = (): Node => {
  const json = structuredClone(BASE_JSON) as unknown as {
    content: Array<{ content: Array<Record<string, unknown>> }>;
  };
  json.content[0]!.content.push({
    type: 'style_def',
    attrs: { id: 'Clause', kind: 'paragraph', name: 'Clause', basedOn: 'LegalBody' },
  });
  const terms = json.content[1]!.content.find(
    (b) => (b['attrs'] as Record<string, unknown> | undefined)?.['id'] === TERMS,
  )!;
  ((terms['content'] as Array<Record<string, unknown>>)[0]!['attrs'] as Record<string, unknown>)[
    'style'
  ] = 'Clause';
  return schema.nodeFromJSON(json);
};

describe('a refused lease leaves the held lease as it was (PRM-043)', () => {
  it('refuses a region another user holds, and neither the held lease nor the grants change', () => {
    const held: PermissionState = {
      ...basePermissions(),
      leases: [{ region: TERMS, holder: 'alice', expiresAt: NOW + 1000, id: 'a', acquiredAt: NOW }],
    };
    const before = structuredClone(held);
    const verdict = acquireLease({
      access: access(USERS.carol, held),
      perms: held,
      region: TERMS,
      holder: 'carol',
      now: NOW,
      id: 'carols-lease',
    });
    expect(verdict).toMatchObject({ ok: false, code: 'conflict', held: { holder: 'alice' } });
    expect(held).toEqual(before);
    expect(held.leases).toEqual([
      { region: TERMS, holder: 'alice', expiresAt: NOW + 1000, id: 'a', acquiredAt: NOW },
    ]);
  });
});

describe('a restore recreates a missing definition for a user with structure (PRM-050)', () => {
  it('stores the recreated style in the document, and the restored paragraph uses it', () => {
    const old = withClause();
    const current = baseDoc(); // `Clause` no longer exists; the Terms region was edited since.
    const oldTerms = old.nodeAt(posOf(old, TERMS))!;
    const plan = planRestoreDefinitions(oldTerms, old, current, true);
    expect(plan.recreate.map((d) => d.attrs['id'])).toEqual(['Clause']);
    expect(plan.replaced).toEqual([]);

    const room = roomWith(current, morePermissions(), () => NOW);
    const at = posOf(current, TERMS);
    const tr = new Transform(current);
    tr.replaceWith(at + 1, at + current.nodeAt(at)!.nodeSize - 1, plan.region.content);
    // Definitions keep their order in `defs`: the recreated style goes after the last style.
    let afterStyles = 1;
    current.child(0).forEach((d, offset) => {
      if (d.type.name === 'style_def') afterStyles = 1 + offset + d.nodeSize;
    });
    tr.insert(afterStyles, plan.recreate);

    const fx = room.author('control', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(tr.steps),
      origin: 'restore',
      as: USERS.carol,
      region: TERMS,
    });
    expect(messages(fx, 'control').find((m) => m.t === 'sync.reject')).toBeUndefined();

    // The stored document, not only the steps, holds the definition and the paragraph's style.
    for (let fx2 = room.writeCompleted({ status: 'ok' }); fx2.write;) {
      fx2 = room.writeCompleted({ status: 'ok' });
    }
    const ids: unknown[] = [];
    room.document.child(0).forEach((d) => {
      if (d.type.name === 'style_def') ids.push(d.attrs['id']);
    });
    expect(ids).toContain('Clause');
    const region = room.document.nodeAt(posOf(room.document, TERMS))!;
    expect(region.child(0).attrs['style']).toBe('Clause');
  });
});
