// The participant's session and the end of a participant's part in the reference host (UX-106).
// The token endpoint and the page are checked in a real browser (e2e/w3-ux-106-fill-and-sign.spec.ts);
// these tests hold the rules they rest on.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PARTICIPANT_SESSION_MS,
  ParticipantSessions,
} from '../src/lib/server/participant-session.ts';
import {
  WorkflowStore,
  handleWorkflowEvent,
  issueParticipantToken,
  type EventDeps,
  type WorkflowRecord,
} from '../src/lib/server/send-for-completion.ts';

describe('the participant session', () => {
  it('belongs to the invitation it was started through and to one participant', () => {
    const clock = { now: 1_800_000_000_000 };
    const sessions = new ParticipantSessions(() => clock.now);
    const id = sessions.start('ref-1', 'p-1');
    expect(sessions.check(id, 'ref-1')).toEqual({
      participant: 'p-1',
      authTime: Math.floor(clock.now / 1000),
    });
    // Another reference, an unknown cookie and no cookie are not the session.
    expect(sessions.check(id, 'ref-2')).toBeNull();
    expect(sessions.check('not-a-session', 'ref-1')).toBeNull();
    expect(sessions.check(undefined, 'ref-1')).toBeNull();
  });

  it('keeps `auth_time` as the passcode was accepted and ends after its lifetime', () => {
    const clock = { now: 1_800_000_000_000 };
    const sessions = new ParticipantSessions(() => clock.now);
    const id = sessions.start('ref-1', 'p-1');
    clock.now += PARTICIPANT_SESSION_MS - 1;
    expect(sessions.check(id, 'ref-1')?.authTime).toBe(1_800_000_000);
    clock.now += 2;
    expect(sessions.check(id, 'ref-1')).toBeNull();
  });
});

describe("the end of a participant's part", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function world(): Promise<{ d: EventDeps; record: WorkflowRecord }> {
    dir = await mkdtemp(join(tmpdir(), 'docedit-ux106-'));
    const store = await WorkflowStore.open(dir);
    const record: WorkflowRecord = {
      doc: 'doc-1',
      workflow: 'wf-1',
      owner: 'u-olivia',
      sentAt: '2026-11-27T10:00:00.000Z',
      state: 'sent',
      participants: [
        {
          id: 'p-1',
          sub: 'sub-1',
          name: 'Tess',
          email: 't@x.test',
          roles: ['tenant'],
          kind: 'filler',
          order: 1,
        },
        {
          id: 'p-2',
          sub: 'sub-2',
          name: 'Lars',
          email: 'l@x.test',
          roles: ['landlord'],
          kind: 'signer',
          order: 2,
        },
      ],
    };
    await store.put(record);
    const d = {
      host: { tokens: { mode: 'host-signed', issue: (g: unknown) => Promise.resolve(g) } },
      store,
      mail: () => Promise.resolve(),
      publicUrl: 'http://127.0.0.1:1',
    } as unknown as EventDeps;
    return { d, record };
  }

  const event = (type: string, participant: string) =>
    ({
      type,
      subject: 'doc-1',
      test: false,
      webhookId: 'w1',
      body: { data: { participant } },
    }) as never;

  it('is recorded for the participant named by the service, and for nobody else', async () => {
    const { d, record } = await world();
    await handleWorkflowEvent(d, event('dep.workflow.participant_completed.v1', 'p-1'));
    expect(record.participants.map((p) => p.finished)).toEqual(['completed', undefined]);
    expect(record.state).toBe('sent');
    await handleWorkflowEvent(d, event('dep.workflow.participant_completed.v1', 'unknown'));
    expect(record.participants.map((p) => p.finished)).toEqual(['completed', undefined]);
  });

  it('makes the workflow declined when a participant declines', async () => {
    const { d, record } = await world();
    await handleWorkflowEvent(d, event('dep.workflow.participant_declined.v1', 'p-2'));
    expect(record.participants[1]?.finished).toBe('declined');
    expect(record.state).toBe('declined');
  });

  it('mints a token that says how the host authenticated the participant', async () => {
    const { d, record } = await world();
    const grant = (await issueParticipantToken(
      d,
      record,
      record.participants[0]!,
      1_800_000_000,
    )) as unknown as {
      doc: string;
      role: string;
      participant: { id: string; amr: string[]; authTime: number };
    };
    expect(grant).toMatchObject({
      doc: 'doc-1',
      role: 'filler',
      participant: { id: 'p-1', amr: ['otp'], authTime: 1_800_000_000 },
    });
  });
});
