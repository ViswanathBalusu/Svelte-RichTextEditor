/**
 * People through the host's directory (UX-025; 13 §5): batches of unique identifiers, a session
 * cache, fallbacks when the host is absent, slow or failing, retries, and safe values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolveUsers, UserInfo } from '../src/core-api.ts';
import { PeopleDirectory, safeAvatarUrl } from '../src/people/directory.ts';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function host(directory: Record<string, UserInfo | null>) {
  const calls: string[][] = [];
  const resolveUsers: ResolveUsers = async (ids) => {
    calls.push([...ids]);
    return ids.map((id) => directory[id] ?? null);
  };
  return { calls, resolveUsers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveUsers (UX-025, criterion 1)', () => {
  it('is called once per task with unique identifiers, and answers are cached for the session', async () => {
    const { calls, resolveUsers } = host({
      u1: { id: 'u1', name: 'Ada Lovelace' },
      u2: { id: 'u2', name: 'Grace Hopper', avatarUrl: 'https://example.test/g.png' },
    });
    const people = new PeopleDirectory({ resolveUsers });
    people.request(['u1', 'u2', 'u1']);
    people.request(['u2', 'u3']);
    await flush();
    expect(calls).toEqual([['u1', 'u2', 'u3']]);
    expect(people.lookup('u1')).toMatchObject({ name: 'Ada Lovelace', resolved: true });
    expect(people.lookup('u2').avatarUrl).toBe('https://example.test/g.png');
    // Asked again later: served from the cache, including "unknown".
    people.request(['u1', 'u2', 'u3']);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('splits large requests into batches', async () => {
    const { calls, resolveUsers } = host({});
    const people = new PeopleDirectory({ resolveUsers, batchSize: 2 });
    people.request(['a', 'b', 'c', 'd', 'e']);
    await flush();
    expect(calls).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('notifies the shell when answers arrive', async () => {
    const { resolveUsers } = host({ u1: { id: 'u1', name: 'Ada' } });
    const people = new PeopleDirectory({ resolveUsers });
    const listener = vi.fn();
    people.view.subscribe(listener);
    const before = people.view.get();
    people.request(['u1']);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(people.view.get()).not.toBe(before);
  });
});

describe('fallbacks (UX-025, criteria 2 and 3)', () => {
  it('uses the service name, then nothing, when the host has no resolveUsers', () => {
    const people = new PeopleDirectory();
    people.request(['u1']);
    expect(people.lookup('u1', 'From token')).toEqual({
      id: 'u1',
      name: 'From token',
      avatarUrl: null,
      resolved: false,
    });
    // Null name: the shell shows its neutral label ("Collaborator").
    expect(people.lookup('u1').name).toBeNull();
  });

  it('falls back to the service name for identifiers the host does not know', async () => {
    const { resolveUsers } = host({});
    const people = new PeopleDirectory({ resolveUsers });
    people.request(['u9']);
    await flush();
    expect(people.lookup('u9', 'Service Name')).toMatchObject({
      name: 'Service Name',
      resolved: true,
    });
  });

  it('never waits for a slow host', () => {
    const resolveUsers: ResolveUsers = () => new Promise(() => {});
    const people = new PeopleDirectory({ resolveUsers });
    people.request(['u1']);
    expect(people.lookup('u1', 'Service Name').name).toBe('Service Name');
  });

  it('keeps the fallback when the host rejects, and retries later', async () => {
    vi.useFakeTimers();
    let fail = true;
    const calls: string[][] = [];
    const resolveUsers: ResolveUsers = async (ids) => {
      calls.push([...ids]);
      if (fail) throw new Error('directory unavailable');
      return ids.map((id) => ({ id, name: `Name of ${id}` }));
    };
    const errors: unknown[] = [];
    const people = new PeopleDirectory({
      resolveUsers,
      retryDelaysMs: [1000, 5000],
      onError: (e) => errors.push(e),
    });
    people.request(['u1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    expect(people.lookup('u1', 'Fallback').name).toBe('Fallback');
    // While a retry is pending, asking again does not call the host.
    people.request(['u1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(3);
    expect(people.lookup('u1', 'Fallback')).toMatchObject({ name: 'Name of u1', resolved: true });
  });

  it('survives a resolveUsers that throws synchronously or answers nonsense', async () => {
    const throwing: ResolveUsers = () => {
      throw new Error('sync failure');
    };
    const a = new PeopleDirectory({ resolveUsers: throwing, setTimer: () => 0 });
    a.request(['u1']);
    await flush();
    expect(a.lookup('u1', 'Fallback').name).toBe('Fallback');

    const nonsense = (async () => 'not an array') as unknown as ResolveUsers;
    const b = new PeopleDirectory({ resolveUsers: nonsense });
    b.request(['u1']);
    await flush();
    expect(b.lookup('u1', 'Fallback')).toMatchObject({ name: 'Fallback', resolved: true });
  });
});

describe('a host that sets its directory after the editor has loaded (PRO-080; PRM-026)', () => {
  /** As the element reads the host's property at each call: null while the host has set none. */
  function lateHost() {
    const state: { callback: ResolveUsers | null; calls: string[][] } = {
      callback: null,
      calls: [],
    };
    const people = new PeopleDirectory({ resolveUsers: (ids) => state.callback?.(ids) ?? null });
    const set = (directory: Record<string, UserInfo | null>): void => {
      state.callback = async (ids) => {
        state.calls.push([...ids]);
        return ids.map((id) => directory[id] ?? null);
      };
    };
    return { people, state, set };
  }

  it('keeps nothing while the host has no directory, and asks again when it has one', async () => {
    const { people, state, set } = lateHost();
    const listener = vi.fn();
    people.view.subscribe(listener);
    // The shell asks as soon as it draws: the lock indicators name people at once.
    people.request(['u1', 'u2']);
    await flush();
    // That was not an answer of the host: nothing is resolved, and the shell is told nothing.
    expect(people.lookup('u1', 'Service name')).toEqual({
      id: 'u1',
      name: 'Service name',
      avatarUrl: null,
      resolved: false,
    });
    expect(listener).not.toHaveBeenCalled();

    set({ u1: { id: 'u1', name: 'Ada Lovelace' } });
    people.refresh();
    await flush();
    expect(state.calls).toEqual([['u1', 'u2']]);
    expect(people.lookup('u1', 'Service name')).toMatchObject({
      name: 'Ada Lovelace',
      resolved: true,
    });
    // "Unknown" from the host itself is an answer, and is cached as before.
    expect(people.lookup('u2')).toMatchObject({ name: null, resolved: true });
    expect(listener).toHaveBeenCalledTimes(1);
    people.refresh();
    people.request(['u1', 'u2']);
    await flush();
    expect(state.calls).toHaveLength(1);
  });

  it('asks the host at the next request too, when nobody said the directory arrived', async () => {
    const { people, state, set } = lateHost();
    people.request(['u1']);
    await flush();
    set({ u1: { id: 'u1', name: 'Ada Lovelace' } });
    people.request(['u1']);
    await flush();
    expect(state.calls).toEqual([['u1']]);
    expect(people.lookup('u1').name).toBe('Ada Lovelace');
  });

  it('does nothing at a refresh while there is still no directory, and never loops', async () => {
    const { people, state } = lateHost();
    const listener = vi.fn();
    people.view.subscribe(listener);
    people.request(['u1']);
    await flush();
    people.refresh();
    people.refresh();
    await flush();
    expect(state.calls).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(people.lookup('u1').resolved).toBe(false);
  });
});

describe('values from the host are data (UX-025, criterion 4)', () => {
  it('keeps names as plain strings, whatever they contain', async () => {
    const { resolveUsers } = host({
      u1: { id: 'u1', name: '  <img src=x onerror=alert(1)>  ' },
      u2: { id: 'u2', name: 42 as unknown as string },
    });
    const people = new PeopleDirectory({ resolveUsers });
    people.request(['u1', 'u2']);
    await flush();
    expect(people.lookup('u1').name).toBe('<img src=x onerror=alert(1)>');
    expect(people.lookup('u2', 'Fallback').name).toBe('Fallback');
  });

  it('accepts only image addresses for avatars', () => {
    expect(safeAvatarUrl('https://example.test/a.png')).toBe('https://example.test/a.png');
    expect(safeAvatarUrl('http://example.test/a.png')).toBe('http://example.test/a.png');
    expect(safeAvatarUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(safeAvatarUrl('javascript:alert(1)')).toBeNull();
    expect(safeAvatarUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    // A relative address is resolved against the host page; without a page it cannot be used.
    expect(safeAvatarUrl('/relative.png')).toBeNull();
    expect(safeAvatarUrl('/a.png', 'https://host.example/app/')).toBe('https://host.example/a.png');
    expect(safeAvatarUrl('javascript:alert(1)', 'https://host.example/')).toBeNull();
    expect(safeAvatarUrl('')).toBeNull();
    expect(safeAvatarUrl(undefined)).toBeNull();
  });
});

describe('the directory has no path to the document service (UX-025, criterion 5)', () => {
  it('holds no reference to the core and sends answers nowhere but its own cache', () => {
    const people = new PeopleDirectory({ resolveUsers: async () => [] });
    const fields = Object.getOwnPropertyNames(people);
    expect(fields).toEqual(['view']);
    // `refresh` asks the host again for what it was not asked while it had no directory.
    expect(Object.getOwnPropertyNames(PeopleDirectory.prototype).sort()).toEqual([
      'constructor',
      'lookup',
      'refresh',
      'request',
    ]);
  });
});
