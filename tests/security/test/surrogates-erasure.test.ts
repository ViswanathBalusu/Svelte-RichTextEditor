/**
 * SEC-056 criteria 2 and 4 (10 §4; 08 §13): erasing a user deletes the mapping row from the host
 * `sub` to the surrogate, so the display name is gone and the surrogate leads to nothing, and an
 * erasure in one tenant leaves a user with the same `sub` in another tenant untouched.
 *
 * The tests run against the in-memory user directory, the storage the control plane uses when no
 * PostgreSQL is configured. Criterion 2's history half follows owner decision 39 (docs/owner-decisions-2026-11-15.md):
 * an erased person is shown as an unknown person, with no per-person surrogate shown, through the
 * history label module (packages/history/src/erasure.ts).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { shownAuthor } from '../../../packages/history/src/index.ts';
import { MemoryUserDirectory } from '../../../services/document-service/src/control-plane/users.ts';

describe('SEC-056 criterion 2: an erased user leads to no name and no surrogate', () => {
  it('the display name is gone and the surrogate no longer resolves to a sub', async () => {
    const users = new MemoryUserDirectory();
    const tenant = randomUUID();
    const sub = 'ann.lee@example.test';
    const before = await users.resolve(tenant, sub, 'Ann Lee');
    expect(await users.displayName(tenant, sub)).toBe('Ann Lee');
    expect((await users.subsOf(tenant, [before.surrogate])).get(before.surrogate)).toBe(sub);

    expect(await users.erase(tenant, sub)).toBe(true);

    expect(await users.displayName(tenant, sub)).toBeNull();
    expect((await users.subsOf(tenant, [before.surrogate])).has(before.surrogate)).toBe(false);
    // The erased sub is no longer mapped: a second erasure has nothing to delete.
    expect(await users.erase(tenant, sub)).toBe(false);
  });
});

describe('SEC-056 criterion 4: erasing a user in one tenant leaves the same sub in another', () => {
  it('tenant B keeps its surrogate, name and mapping when tenant A erases the same sub', async () => {
    const users = new MemoryUserDirectory();
    const a = randomUUID();
    const b = randomUUID();
    const sub = 'shared-sub-1';
    const inA = await users.resolve(a, sub, 'Ann in A');
    const inB = await users.resolve(b, sub, 'Ann in B');
    expect(inB.surrogate).not.toBe(inA.surrogate);

    await users.erase(a, sub);

    expect(await users.displayName(a, sub)).toBeNull();
    expect(await users.displayName(b, sub)).toBe('Ann in B');
    expect((await users.subsOf(b, [inB.surrogate])).get(inB.surrogate)).toBe(sub);
    // B's resolve returns the same surrogate as before the erasure of A.
    expect((await users.resolve(b, sub)).surrogate).toBe(inB.surrogate);
  });
});

describe('SEC-056 criterion 2 (owner decision 39): history shows an erased author as an unknown person', () => {
  it('the surrogate that no longer resolves is labelled unknown, with no name, sub or surrogate', async () => {
    const users = new MemoryUserDirectory();
    const tenant = randomUUID();
    const sub = 'ann.lee@example.test';
    const ann = await users.resolve(tenant, sub, 'Ann Lee');
    const bob = await users.resolve(tenant, 'bob@example.test', 'Bob Ray');
    // The author as the log holds it: the surrogate, and an agent when an assistant wrote the run.
    const runs = [
      { user: ann.surrogate },
      { user: ann.surrogate, agent: 'agt-1' },
      { user: bob.surrogate },
    ];

    await users.erase(tenant, sub);

    // The set of erased surrogates is those of the log that no longer lead to a sub.
    const resolved = await users.subsOf(
      tenant,
      runs.map((r) => r.user),
    );
    const erased = new Set(runs.map((r) => r.user).filter((s) => !resolved.has(s)));
    expect([...erased]).toEqual([ann.surrogate]);

    const shown = runs.map((r) => shownAuthor(r, erased));
    expect(shown[0]).toEqual({ kind: 'unknown' });
    expect(shown[1]).toEqual({ kind: 'unknown', agent: 'agt-1' });
    expect(shown[2]).not.toMatchObject({ kind: 'unknown' });
    const text = JSON.stringify(shown.slice(0, 2));
    expect(text).not.toContain(sub);
    expect(text).not.toContain('Ann Lee');
    expect(text).not.toContain(ann.surrogate);
  });
});
