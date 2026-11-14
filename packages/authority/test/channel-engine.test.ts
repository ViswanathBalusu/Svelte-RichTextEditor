import { describe, expect, it, vi } from 'vitest';
import { EngineRegistry, PM_STEPS_1, type EngineDefinition } from '../src/room/engine.ts';
import { openNegotiatedChannel } from '../src/room/channel-engine.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, schema } from './fixtures.ts';
import { MemoryStorage } from './harness/storage.ts';

function newRoom(): Room {
  const storage = new MemoryStorage(baseDoc(), REQUIRES, basePermissions());
  const init: RoomInit = {
    schema,
    initial: storage.initial,
    requires: storage.requires,
    log: storage.log,
    perms: storage.perms,
    initialRevision: storage.initialRevision,
    epoch: storage.epoch,
    incarnation: storage.incarnation,
    now: () => 1_800_000_000_000,
  };
  return new Room(init);
}

/** A second engine that satisfies the contract's four obligations but is not served by the room. */
const OTHER: EngineDefinition = {
  ...(PM_STEPS_1 as EngineDefinition),
  id: 'crdt/1',
};

function registryWith(...engines: EngineDefinition[]): EngineRegistry {
  const registry = new EngineRegistry();
  for (const e of engines) registry.register(e);
  return registry;
}

describe('SYN-046 criterion 4: the channel opens with the negotiated engine', () => {
  it('opens the channel when the engine is registered and negotiated', () => {
    const room = newRoom();
    const registry = registryWith(PM_STEPS_1 as EngineDefinition);
    const result = openNegotiatedChannel(room, registry, {
      channel: 'alice',
      conn: USERS.alice,
      engine: 'pm-steps/1',
      negotiated: registry.negotiate(['pm-steps/1']),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engine).toBe('pm-steps/1');
    expect(result.fx.send.map((o) => o.msg.t)).toContain('ch.opened');
  });

  it('lets the registry decide alone when no negotiated list is given', () => {
    const room = newRoom();
    const registry = registryWith(PM_STEPS_1 as EngineDefinition);
    const result = openNegotiatedChannel(room, registry, {
      channel: 'alice',
      conn: USERS.alice,
      engine: 'pm-steps/1',
    });
    expect(result.ok).toBe(true);
  });

  it('answers unsupported_engine, and opens nothing, when the engine was not negotiated', () => {
    const room = newRoom();
    const open = vi.spyOn(room, 'open');
    const registry = registryWith(PM_STEPS_1 as EngineDefinition);
    const result = openNegotiatedChannel(room, registry, {
      channel: 'alice',
      conn: USERS.alice,
      engine: 'pm-steps/1',
      negotiated: [],
    });
    expect(result).toMatchObject({ ok: false, code: 'unsupported_engine' });
    expect(open).not.toHaveBeenCalled();
  });

  it('answers unsupported_engine for an engine the server does not register', () => {
    const room = newRoom();
    const open = vi.spyOn(room, 'open');
    const registry = registryWith(PM_STEPS_1 as EngineDefinition);
    for (const engine of ['crdt/1', 42, null, undefined, { id: 'pm-steps/1' }]) {
      const result = openNegotiatedChannel(room, registry, {
        channel: 'alice',
        conn: USERS.alice,
        engine,
        negotiated: ['crdt/1', 'pm-steps/1'],
      });
      expect(result).toMatchObject({ ok: false, code: 'unsupported_engine' });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a registered engine that the room does not serve, even when negotiated', () => {
    const room = newRoom();
    const open = vi.spyOn(room, 'open');
    const registry = registryWith(PM_STEPS_1 as EngineDefinition, OTHER);
    const result = openNegotiatedChannel(room, registry, {
      channel: 'alice',
      conn: USERS.alice,
      engine: 'crdt/1',
      negotiated: registry.negotiate(['crdt/1', 'pm-steps/1']),
    });
    expect(result).toMatchObject({ ok: false, code: 'unsupported_engine' });
    expect(open).not.toHaveBeenCalled();
  });
});
