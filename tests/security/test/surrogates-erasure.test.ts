/**
 * SEC-056 criteria 2 and 4 (10 §4; 08 §13): erasing a user deletes the mapping row from the host
 * `sub` to the surrogate, so the display name is gone and the surrogate leads to nothing, and an
 * erasure in one tenant leaves a user with the same `sub` in another tenant untouched.
 *
 * The tests run against the in-memory user directory, the storage the control plane uses when no
 * PostgreSQL is configured. Criterion 2's "history renders contributions under the surrogate" is not
 * proved here: the history label module (packages/history/src/erasure.ts) shows an erased author as
 * an unknown person, not as the surrogate. That is recorded in the story's Notes, not decided here.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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
