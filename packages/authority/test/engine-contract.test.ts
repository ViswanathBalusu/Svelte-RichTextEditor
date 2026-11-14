// The engine extension point (04 §15; SYN-046): what any engine must provide, checked by type and
// at run time, and the negotiation of the engine per channel (05 §5.1, §5.2).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type EngineDefinition,
  EngineRegistry,
  PM_STEPS_1,
  engineContractFailures,
  isRefusal,
} from '../src/room/engine.ts';
import type { Resume } from '../src/room/types.ts';

const sample = {
  position: { seq: 4, incarnation: 'inc-1', inflight: null } satisfies Resume,
  change: {
    id: '0192f0c4-7b1e-7000-8000-000000000001',
    base: 4,
    steps: [{ stepType: 'replace', from: 1, to: 1 }],
    user: 'mallory',
    time: 0,
  },
};

describe('the engine contract (SYN-046)', () => {
  it('is met by pm-steps/1, through the interface alone', () => {
    expect(engineContractFailures(PM_STEPS_1, sample)).toEqual([]);
    expect(PM_STEPS_1).toMatchObject({ id: 'pm-steps/1', payloads: 'json' });
    // Server attribution: the claims of the change are not kept, the stamp is the server's.
    const read = PM_STEPS_1.readChange(sample.change);
    if (isRefusal(read)) throw new Error(read.reason);
    const stamped = PM_STEPS_1.attribute(read, { user: 'carol', session: 's-carol', time: 7 });
    expect(stamped.attribution).toEqual({ user: 'carol', session: 's-carol', time: 7 });
    expect(JSON.stringify(stamped.change)).not.toContain('mallory');
    // The resume token round-trips; anything else is no token.
    expect(
      PM_STEPS_1.readResume(PM_STEPS_1.resumeToken({ ...sample.position, view: 'v1' })),
    ).toEqual({
      ...sample.position,
      view: 'v1',
    });
    expect(PM_STEPS_1.readResume({ seq: '4', incarnation: 'inc-1' })).toBeNull();
  });

  it('fails for an engine that has no way to refuse a change, at compile time and at run time', () => {
    const { refuse: _refuse, ...rest } = PM_STEPS_1;
    // @ts-expect-error: `refuse` is required (04 §15: a way for the server to refuse a change).
    const lacking: EngineDefinition<Resume> = rest;
    expect(engineContractFailures(lacking, sample)).toContain(
      'no refuse: the engine cannot refuse a change',
    );
    const registry = new EngineRegistry();
    expect(() => registry.register(lacking as EngineDefinition)).toThrow(/no refuse/);
    // The same for the other obligations.
    for (const member of ['readResume', 'resumeToken', 'attribute'] as const) {
      const without = { ...PM_STEPS_1, [member]: undefined } as unknown as EngineDefinition<Resume>;
      expect(engineContractFailures(without, sample).join('; '), member).toMatch(`no ${member}`);
    }
    const noPayload = { ...PM_STEPS_1, payloads: 'xml' } as unknown as EngineDefinition<Resume>;
    expect(engineContractFailures(noPayload, sample)).toContain(
      'payloads must be "json" or "binary"',
    );
  });

  it('negotiates the engine of a channel through hello.engines and ch.open.engine', () => {
    const registry = new EngineRegistry();
    registry.register(PM_STEPS_1 as EngineDefinition);
    const negotiated = registry.negotiate(['crdt/1', 'pm-steps/1', 42]);
    expect(negotiated).toEqual(['pm-steps/1']);
    expect(registry.forChannel('pm-steps/1', negotiated)).toMatchObject({ ok: true });
    expect(registry.forChannel('crdt/1', negotiated)).toMatchObject({
      ok: false,
      code: 'unsupported_engine',
    });
    // An engine the server offers but the session did not negotiate is refused too.
    expect(registry.forChannel('pm-steps/1', [])).toMatchObject({
      ok: false,
      code: 'unsupported_engine',
    });
  });

  it('names no ProseMirror type in the contract or the protocol package', () => {
    const contract = readFileSync(new URL('../src/room/engine.ts', import.meta.url), 'utf8');
    expect(contract).not.toMatch(/from ['"]prosemirror-/);
    const protocol = new URL('../../protocol/src/', import.meta.url);
    const files = readdirSync(protocol, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const f of files)
      expect(readFileSync(new URL(f.replaceAll('\\', '/'), protocol), 'utf8'), f).not.toMatch(
        /from ['"]prosemirror-/,
      );
  });
});
