// A fill in a document at the limits of 2,000 fields and 500 rules (FRW-019 criterion 5; 12 §3.6,
// §5.2; 04 §12): the room evaluates what the filled field depends on within its budget, so the
// fill is accepted, and a budget that is spent refuses the fill with `rate_limited`.
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
const FIELD_LIMIT = 2000;
const RULE_LIMIT = 500;

/**
 * The base document at the limits: about 2,000 fields in all, 500 rules in the definitions, and
 * the rule that shows the tenant's name once the flag is set. The flag is set in the document.
 */
function atLimits() {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  const rules: J[] = [
    {
      id: 'rHideName',
      when: { empty: [{ field: 'tenant.flag' }] },
      then: [{ hide: ['tenant.name'] }],
    },
  ];
  for (let i = rules.length; i < RULE_LIMIT; i++)
    rules.push({ id: `rd${i}`, when: true, then: [] });
  json.content[0]!.content.push(...rules.map((attrs) => ({ type: 'rule_def', attrs })));
  const intro = json.content[1]!.content[1]!;
  const fields: J[] = [
    {
      type: 'form_field',
      attrs: {
        id: FLAG,
        key: 'tenant.flag',
        kind: 'text',
        label: 'Flag',
        assignee: 'role_tenant',
        value: 'yes',
      },
    },
  ];
  for (let i = fields.length; i < FIELD_LIMIT - 1; i++) {
    fields.push({
      type: 'form_field',
      attrs: {
        id: `fLim${String(i).padStart(12, '0')}`,
        key: `limit.f${i}`,
        kind: 'text',
        label: `Field ${i}`,
        assignee: null,
        value: null,
      },
    });
  }
  intro['content'] = [
    ...((intro['content'] as J[] | undefined) ?? []),
    ...fields.flatMap((f) => [{ type: 'text', text: ' ' }, f]),
  ];
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

function room(doc: ReturnType<typeof atLimits>, extra: Partial<RoomInit> = {}): Room {
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

describe('a fill at the limits of 2,000 fields and 500 rules (FRW-019 criterion 5)', () => {
  it('accepts a fill whose rule evaluation finishes inside the budget', () => {
    const doc = atLimits();
    const count = (() => {
      let n = 0;
      doc.descendants((x) => {
        if (x.type.name === 'form_field') n++;
        return true;
      });
      return n;
    })();
    expect(count).toBe(FIELD_LIMIT);
    const r = room(doc);
    r.open('e1', USERS.erin);
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([new AttrStep(posOf(doc, NAME), 'value', 'Ada')]),
    });
    expect(rejection(fx, 'e1')).toBeUndefined();
    expect(fx.write).not.toBeNull();
  });

  it('refuses the same fill with rate_limited, without stalling, when the budget is spent', () => {
    const doc = atLimits();
    const r = room(doc, { ruleBudget: 1 });
    r.open('e1', USERS.erin);
    const fx = r.submit('e1', {
      id: id(),
      base: 0,
      steps: stepsToJson([new AttrStep(posOf(doc, NAME), 'value', 'Ada')]),
    });
    expect(rejection(fx, 'e1')).toMatchObject({ code: 'rate_limited', action: 'retry' });
    expect(fx.write).toBeNull();
  });
});
