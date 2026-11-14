// The developer documentation names the order-sensitive events the element attaches with `on`
// (FE-025, review checklist): the list in ADR 0039 §8 must match ORDER_SENSITIVE_EVENTS.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORDER_SENSITIVE_EVENTS } from '../src/shortcuts.ts';

const adrPath = resolve(
  import.meta.dirname,
  '../../../docs/adr/0039-element-embedding-decisions.md',
);
const LEAD = 'Order-sensitive handlers (FE-025), attached with `on`: ';

describe('the order-sensitive events (FE-025)', () => {
  it('are named in ADR 0039 §8 with the same members as the code', () => {
    const adr = readFileSync(adrPath, 'utf8');
    const line = adr.split('\n').find((l) => l.startsWith(LEAD));
    expect(line, 'the documented list is missing from ADR 0039 §8').toBeDefined();
    const listPart = (line ?? '').slice(LEAD.length).split('. The list is')[0] ?? '';
    const documented = [...listPart.matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1] ?? '');
    expect([...documented].sort()).toEqual([...ORDER_SENSITIVE_EVENTS].sort());
  });
});
