// FND-008: the shapes of the control plane's resources are not in the client's first load; the
// REST client loads them with the first response that names one, and still checks that response
// against the shape (05 §1 rule 3: unknown members pass, a wrong type does not).
import { describe, expect, it } from 'vitest';
import { PortError } from '@docedit/protocol';
import { RestClient } from '../src/rest.ts';
import type { Platform, ResponseLike } from '../src/platform.ts';

function clientAnswering(body: unknown): RestClient {
  const fetch = async (): Promise<ResponseLike> => ({
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });
  return new RestClient('https://dep.test/api', { fetch } as unknown as Platform, {
    token: async () => 'secret-token',
    renew: async () => 'renewed-token',
  });
}

describe('a response checked against a shape loaded on first use (FND-008)', () => {
  it('passes a body that matches, with members the shape does not know', async () => {
    const rest = clientAnswering({ seq: 3, kind: 'named', name: 'v1', extra: 'allowed' });
    const result = await rest.call<{ seq: number }>('GET', '/documents/d1/versions/3', {
      shape: 'Version',
    });
    expect(result.value.seq).toBe(3);
  });

  it('refuses a body of the wrong type, and names the shape', async () => {
    const rest = clientAnswering({ seq: 'three', kind: 'named' });
    const error = await rest
      .call('GET', '/documents/d1/versions/3', { shape: 'Version' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).message).toContain('does not match Version');
  });

  it('checks each item of a list against the shape', async () => {
    const rest = clientAnswering({
      items: [{ seq: 1, kind: 'named' }, { seq: 'x' }],
      nextCursor: null,
    });
    const error = await rest
      .call('GET', '/documents/d1/versions', { shape: 'Version', list: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).message).toContain('/items/1');
  });
});
