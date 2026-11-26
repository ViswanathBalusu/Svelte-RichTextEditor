// The consent step's service over the workflow port (FRW-044 criterion 1; FRW-033): the text and the
// acceptance on record are read from the port, an acceptance is a `consent` call with no body (the
// client supplies no text and no hash), a decline goes with its reason, and a participant the server
// has not identified calls nothing. Node.js, stand-in port.
import { PortError, type WorkflowPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { consentService, type SigningSource } from '../src/signing.ts';

type Port = Pick<WorkflowPort, 'consent' | 'participant'>;

function setup(overrides: Partial<Port> = {}, participant: string | null = 'p1') {
  const calls: string[] = [];
  const port: Port = {
    consent: async (doc, pid) => {
      calls.push(`consent ${doc} ${pid}`);
      return {
        textId: 'esign-consent',
        version: 3,
        text: 'I agree.\n\nTest text.',
        acceptedAt: null,
      } as never;
    },
    participant: async (doc, pid, action, body) => {
      calls.push(`${action} ${doc} ${pid} ${JSON.stringify(body ?? null)}`);
      return {} as never;
    },
    ...overrides,
  };
  const source: SigningSource = {
    assets: {} as never,
    fields: {} as never,
    docId: 'd1',
    workflow: port,
  };
  return {
    calls,
    service: consentService(
      () => source,
      () => participant,
    ),
  };
}

describe('the consent step over the workflow port (FRW-044)', () => {
  it('reads the text the service holds, with its identifier, version and acceptance', async () => {
    const { service, calls } = setup();
    expect(await service.load()).toEqual({
      ok: true,
      consent: {
        textId: 'esign-consent',
        version: 3,
        text: 'I agree.\n\nTest text.',
        acceptedAt: null,
      },
    });
    expect(calls).toEqual(['consent d1 p1']);
  });

  it('says there is nothing to accept for a workflow with no consent text or a kind that accepts none', async () => {
    const { service } = setup({
      consent: async () => {
        throw new PortError('conflict', 'the workflow names no consent text');
      },
    });
    expect(await service.load()).toEqual({ ok: false, reason: 'none' });
  });

  it('says it failed for any other refusal', async () => {
    const { service } = setup({
      consent: async () => {
        throw new PortError('forbidden', 'only the participant reads the consent text');
      },
    });
    expect(await service.load()).toEqual({ ok: false, reason: 'failed' });
  });

  it('records an acceptance with an empty body: no text, no hash and no time from the client', async () => {
    const { service, calls } = setup();
    expect(await service.accept()).toEqual({ ok: true });
    expect(calls).toEqual(['consent d1 p1 null']);
  });

  it('maps a refused acceptance to a word', async () => {
    const forbidden = setup({
      participant: async () => {
        throw new PortError('forbidden', 'the token is not bound to this participant');
      },
    });
    expect(await forbidden.service.accept()).toEqual({ ok: false, reason: 'forbidden' });
    const failed = setup({
      participant: async () => {
        throw new Error('network');
      },
    });
    expect(await failed.service.accept()).toEqual({ ok: false, reason: 'failed' });
  });

  it('declines with the reason, trimmed, and refuses a blank reason without calling the server', async () => {
    const { service, calls } = setup();
    expect(await service.decline('   ')).toEqual({ ok: false, reason: 'reason_required' });
    expect(calls).toEqual([]);
    expect(await service.decline('  I do not agree  ')).toEqual({ ok: true });
    expect(calls).toEqual(['decline d1 p1 {"reason":"I do not agree"}']);
  });

  it('calls nothing while the server has not said who the participant is', async () => {
    const { service, calls } = setup({}, null);
    expect(await service.load()).toEqual({ ok: false, reason: 'failed' });
    expect(await service.accept()).toEqual({ ok: false, reason: 'failed' });
    expect(await service.decline('why')).toEqual({ ok: false, reason: 'failed' });
    expect(calls).toEqual([]);
  });

  it('has no consent to accept when the backend has no workflow port', async () => {
    const service = consentService(
      () => ({ assets: {} as never, fields: {} as never, docId: 'd1' }),
      () => 'p1',
    );
    expect(await service.load()).toEqual({ ok: false, reason: 'none' });
  });
});
