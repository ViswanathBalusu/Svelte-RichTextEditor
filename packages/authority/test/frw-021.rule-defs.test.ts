// Rules and roles live in the document's definitions and change only with `structure` (FRW-021;
// 12 §5.4; 07 §2, §5): a user without `structure` cannot add, change or delete a `rule_def` or a
// `role_def`, and a user with it can change a rule in a draft like any other change.
import { AttrStep, ReplaceStep } from 'prosemirror-transform';
import { Fragment, Slice } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, posOf, schema } from './fixtures.ts';

let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

type J = Record<string, unknown>;

/** The base document with the given rule definitions in its definitions. */
function withRules(rules: J[]) {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  json.content[0]!.content.push(...rules.map((attrs) => ({ type: 'rule_def', attrs })));
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

const RULE = { id: 'rHideName', when: true, then: [] };

function room(doc: ReturnType<typeof withRules>, extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: doc,
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_800_000_000_000,
    ...extra,
  });
}

type Reject = Extract<ToClient, { t: 'sync.reject' }>;
function rejection(fx: Effects, channel: string): Reject | undefined {
  const m = fx.send.find((o) => o.channel === channel && o.msg.t === 'sync.reject')?.msg;
  return m?.t === 'sync.reject' ? m : undefined;
}

describe('rule and role definitions need structure (FRW-021; 12 §5.4)', () => {
  it('refuses a user without structure who adds a rule_def, naming the definitions scope', () => {
    const doc = withRules([RULE]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    const at = posOf(doc, RULE.id);
    const added = schema.nodes['rule_def']!.create({ id: 'rExtra', when: true, then: [] });
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([new ReplaceStep(at, at, new Slice(Fragment.from(added), 0, 0))]),
    });
    expect(rejection(fx, 'e1')).toMatchObject({ code: 'permission_denied' });
    expect(rejection(fx, 'e1')?.scopes ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/^defs/)]),
    );
  });

  it('refuses a user without structure who changes a rule_def, and the document keeps the rule', () => {
    const doc = withRules([RULE]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([new AttrStep(posOf(doc, RULE.id), 'when', false)]),
    });
    expect(rejection(fx, 'e1')).toMatchObject({ code: 'permission_denied' });
    expect(r.document.eq(doc)).toBe(true);
  });

  it('refuses a user without structure who deletes a rule_def', () => {
    const doc = withRules([RULE]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    const at = posOf(doc, RULE.id);
    const size = doc.nodeAt(at)!.nodeSize;
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([new ReplaceStep(at, at + size, Slice.empty)]),
    });
    expect(rejection(fx, 'e1')).toMatchObject({ code: 'permission_denied' });
  });

  it('accepts a change to a rule by a user with structure in a draft, and writes it', () => {
    const doc = withRules([RULE]);
    const r = room(doc);
    r.open('a1', USERS.alice);
    const fx = r.submit('a1', {
      id: id(),
      base: 0,
      steps: stepsToJson([new AttrStep(posOf(doc, RULE.id), 'when', false)]),
    });
    expect(rejection(fx, 'a1')).toBeUndefined();
    expect(fx.write).not.toBeNull();
    r.writeCompleted({ status: 'ok' });
    expect(r.document.nodeAt(posOf(doc, RULE.id))!.attrs['when']).toBe(false);
  });
});

describe('role definitions need structure too (FRW-021 criterion 1; 12 §5.4)', () => {
  const ROLE = 'role_tenant'; // the fixture's role_def, which a field is assigned to
  /**
   * A second role no field is assigned to. Deleting `role_tenant` would leave a field assigned to
   * a missing role, which the invariants refuse (`invalid_op`) before permissions are checked.
   */
  const SPARE = 'role_spare';
  /** A region editor: may edit the legal region through a grant, but has no `structure` (07 §2). */
  const rita = { ...USERS.bob, sub: 'rita', session: 's-rita', role: 'viewer' as const };
  const withoutStructure = [
    ['a filler', USERS.erin],
    ['a region editor', rita],
  ] as const;

  /** The base document with the spare role in its definitions. */
  function withRoles() {
    const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
    json.content[0]!.content.push({
      type: 'role_def',
      attrs: { id: SPARE, name: 'Spare', color: '#2CA02C' },
    });
    const doc = schema.nodeFromJSON(json);
    doc.check();
    return doc;
  }

  function submitAs(user: (typeof withoutStructure)[number][1], steps: unknown) {
    const doc = withRoles();
    const r = room(doc);
    r.open('c1', user);
    const fx = r.submit('c1', { id: id(), base: 0, steps });
    return { doc, r, fx };
  }

  it('lets the region editor change their region, so a refusal below is about the definitions', () => {
    const doc = withRoles();
    const at = posOf(doc, 'pLegal000000001B') + 1;
    const { fx } = submitAs(
      rita,
      stepsToJson([new ReplaceStep(at, at, new Slice(Fragment.from(schema.text('x')), 0, 0))]),
    );
    expect(rejection(fx, 'c1')).toBeUndefined();
    expect(fx.write).not.toBeNull();
  });

  for (const [who, user] of withoutStructure) {
    it(`refuses ${who} who adds a role_def, naming its definitions scope`, () => {
      const doc = withRoles();
      const at = posOf(doc, ROLE);
      const added = schema.nodes['role_def']!.create({
        id: 'role_landlord',
        name: 'Landlord',
        color: '#FF7F0E',
      });
      const { r, fx } = submitAs(
        user,
        stepsToJson([new ReplaceStep(at, at, new Slice(Fragment.from(added), 0, 0))]),
      );
      const m = rejection(fx, 'c1');
      expect(m).toMatchObject({ code: 'permission_denied' });
      expect(m?.scopes).toEqual(expect.arrayContaining(['defs:role_def/role_landlord']));
      expect(fx.write).toBeNull();
      expect(r.document.eq(doc)).toBe(true);
    });

    it(`refuses ${who} who changes a role_def, and the document keeps the role`, () => {
      const doc = withRoles();
      const { r, fx } = submitAs(
        user,
        stepsToJson([new AttrStep(posOf(doc, ROLE), 'name', 'Occupant')]),
      );
      const m = rejection(fx, 'c1');
      expect(m).toMatchObject({ code: 'permission_denied' });
      expect(m?.scopes).toEqual(expect.arrayContaining([`defs:role_def/${ROLE}`]));
      expect(fx.write).toBeNull();
      expect(r.document.eq(doc)).toBe(true);
    });

    it(`refuses ${who} who deletes a role_def`, () => {
      const doc = withRoles();
      const at = posOf(doc, SPARE);
      const size = doc.nodeAt(at)!.nodeSize;
      const { r, fx } = submitAs(user, stepsToJson([new ReplaceStep(at, at + size, Slice.empty)]));
      const m = rejection(fx, 'c1');
      expect(m).toMatchObject({ code: 'permission_denied' });
      expect(m?.scopes).toEqual(expect.arrayContaining([`defs:role_def/${SPARE}`]));
      expect(fx.write).toBeNull();
      expect(r.document.eq(doc)).toBe(true);
    });
  }

  it('accepts a change to a role, and the deletion of an unused one, by a user with structure', () => {
    const doc = withRoles();
    const r = room(doc);
    r.open('a1', USERS.alice);
    const fx = r.submit('a1', {
      id: id(),
      base: 0,
      steps: stepsToJson([new AttrStep(posOf(doc, ROLE), 'name', 'Occupant')]),
    });
    expect(rejection(fx, 'a1')).toBeUndefined();
    expect(fx.write).not.toBeNull();
    r.writeCompleted({ status: 'ok' });
    const at = posOf(r.document, SPARE);
    const size = r.document.nodeAt(at)!.nodeSize;
    const fx2 = r.submit('a1', {
      id: id(),
      base: 1,
      steps: stepsToJson([new ReplaceStep(at, at + size, Slice.empty)]),
    });
    expect(rejection(fx2, 'a1')).toBeUndefined();
    expect(fx2.write).not.toBeNull();
  });
});
