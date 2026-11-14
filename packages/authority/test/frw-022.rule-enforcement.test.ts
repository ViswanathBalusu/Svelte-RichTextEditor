// The authority enforces what the rules show, disable, require and check for a fill (FRW-022;
// 12 §4.2 P7, §5.3): a field hidden, disabled or read-only is refused, a commit that sets a
// controlling field and its dependent field together is judged on the document after the commit,
// a participant who is not active is refused, and a `require` effect does not refuse a fill.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, posOf, schema } from './fixtures.ts';

let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

type J = Record<string, unknown>;

const NAME = 'fTenantName00001';
const FLAG = 'fFlag00000000001';
const FIXED = 'fFixed0000000001';

/**
 * The base document with a flag field and a read-only field, both fillable by the tenant, and the
 * rules in the definitions. The tenant's name is the field the rules act on.
 */
function withRules(rules: J[]) {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  json.content[0]!.content.push(...rules.map((attrs) => ({ type: 'rule_def', attrs })));
  const intro = json.content[1]!.content[1]!;
  const content = (intro['content'] as J[] | undefined) ?? [];
  intro['content'] = [
    ...content,
    { type: 'text', text: ' Flag: ' },
    {
      type: 'form_field',
      attrs: {
        id: FLAG,
        key: 'tenant.flag',
        kind: 'text',
        label: 'Flag',
        assignee: 'role_tenant',
        value: null,
      },
    },
    { type: 'text', text: ' Fixed: ' },
    {
      type: 'form_field',
      attrs: {
        id: FIXED,
        key: 'tenant.fixed',
        kind: 'text',
        label: 'Fixed',
        assignee: 'role_tenant',
        readOnly: true,
        value: 'fixed',
      },
    },
  ];
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

const hideWhenFlagEmpty = {
  id: 'rHideName',
  when: { empty: [{ field: 'tenant.flag' }] },
  then: [{ hide: ['tenant.name'] }],
};
const disableName = { id: 'rDisableName', when: true, then: [{ disable: ['tenant.name'] }] };
const requireName = { id: 'rRequireName', when: true, then: [{ require: ['tenant.name'] }] };

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
const setValue = (doc: ReturnType<typeof withRules>, field: string, value: unknown) =>
  new AttrStep(posOf(doc, field), 'value', value);

describe('the authority enforces the rules on a fill (FRW-022; 12 §4.2 P7)', () => {
  it('refuses a fill of a field disabled by a rule, and the stored value stays unchanged', () => {
    const doc = withRules([disableName]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([setValue(doc, NAME, 'Ada')]),
    });
    expect(rejection(fx, 'e1')).toMatchObject({
      code: 'permission_denied',
      reason: expect.stringMatching(/hidden or disabled by the rules/),
      // The rejection names the rule, so the editor can explain it (12 §5.3).
      rule: 'rDisableName',
      scopes: expect.arrayContaining([`field:${NAME}`]),
    });
    expect(fx.write).toBeNull();
    expect(r.document.eq(doc)).toBe(true);
  });

  it('refuses a fill of a field hidden by a rule, names the rule, and keeps the stored value', () => {
    const doc = withRules([hideWhenFlagEmpty]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([setValue(doc, NAME, 'Ada')]),
    });
    expect(rejection(fx, 'e1')).toMatchObject({
      code: 'permission_denied',
      rule: 'rHideName',
      scopes: expect.arrayContaining([`field:${NAME}`]),
    });
    expect(fx.write).toBeNull();
    expect(r.document.eq(doc)).toBe(true);
  });

  it('names no rule for a refusal the rules did not decide', () => {
    const doc = withRules([requireName]);
    const r = room(doc);
    r.open('e1', { ...USERS.erin, participantActive: false });
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([setValue(doc, FLAG, 'yes')]),
    });
    const m = rejection(fx, 'e1');
    expect(m).toMatchObject({ code: 'permission_denied' });
    expect(m && 'rule' in m).toBe(false);
  });

  it('refuses a fill of a read-only field, as the field itself says', () => {
    const doc = withRules([]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([setValue(doc, FIXED, 'changed')]),
    });
    const m = rejection(fx, 'e1');
    expect(m).toMatchObject({
      code: 'permission_denied',
      reason: expect.stringMatching(/read-only/),
      scopes: expect.arrayContaining([`field:${FIXED}`]),
    });
    // No rule disabled it: the field's own `readOnly` flag did, and the reason says so. `rule`
    // names a rule definition, so it is left out (FRW-022 Notes).
    expect(m && 'rule' in m).toBe(false);
    expect(fx.write).toBeNull();
    expect(r.document.eq(doc)).toBe(true);
  });

  it('refuses a read-only field even when a rule would enable it, and names no rule', () => {
    const enableFixed = { id: 'rEnableFixed', when: true, then: [{ enable: ['tenant.fixed'] }] };
    const doc = withRules([enableFixed]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([setValue(doc, FIXED, 'changed')]),
    });
    const m = rejection(fx, 'e1');
    expect(m).toMatchObject({ code: 'permission_denied' });
    expect(m && 'rule' in m).toBe(false);
    expect(r.document.eq(doc)).toBe(true);
  });

  it('judges a commit that sets a controlling field and its dependent field together on the result', () => {
    const doc = withRules([hideWhenFlagEmpty]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    // The flag becomes "yes" in the same commit that fills the name it reveals: visible after
    // the commit, so the fill is accepted.
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([setValue(doc, FLAG, 'yes'), setValue(doc, NAME, 'Ada')]),
    });
    expect(rejection(fx, 'e1')).toBeUndefined();
    expect(fx.write).not.toBeNull();
  });

  it('refuses the same name fill when the controlling field stays empty', () => {
    const doc = withRules([hideWhenFlagEmpty]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([setValue(doc, NAME, 'Ada')]),
    });
    expect(rejection(fx, 'e1')).toMatchObject({
      code: 'permission_denied',
      reason: expect.stringMatching(/hidden or disabled by the rules/),
    });
  });

  it('refuses a fill by a participant who is not active, and accepts it once active', () => {
    const doc = withRules([]);
    const r = room(doc);
    r.open('e1', { ...USERS.erin, participantActive: false });
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([setValue(doc, FLAG, 'yes')]),
    });
    expect(rejection(fx, 'e1')).toMatchObject({ code: 'permission_denied' });
  });

  it('does not refuse a fill because a required field is still empty (checked at completion)', () => {
    const doc = withRules([requireName]);
    const r = room(doc);
    r.open('e1', USERS.erin);
    // The name stays empty and required; the commit only sets the flag.
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([setValue(doc, FLAG, 'yes')]),
    });
    expect(rejection(fx, 'e1')).toBeUndefined();
    expect(fx.write).not.toBeNull();
  });
});
