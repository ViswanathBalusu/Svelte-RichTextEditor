// UX-078 criterion 3 (owner decision 110): a refusal that names the kind of quota keeps the name
// when the backend turns the REST problem or the socket `error` into a port error, so the element
// can tell the person which quota was reached.
import { describe, expect, it } from 'vitest';
import { refusal } from '../src/connection.ts';
import { problemOf } from '../src/rest.ts';

const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
});

describe('the quota kind of a refusal', () => {
  it('stays in the details of a REST problem with the wait of Retry-After', async () => {
    const error = await problemOf(
      response(
        429,
        {
          code: 'quota_exceeded',
          detail: 'the tenant has reached its storage quota',
          quota: 'storage',
        },
        { 'retry-after': '1' },
      ) as never,
      'upload',
    );
    expect(error.code).toBe('quota_exceeded');
    expect(error.retryAfterMs).toBe(1000);
    expect(error.details?.['quota']).toBe('storage');
  });

  it('stays in the details of a socket error that refused the session', () => {
    const error = refusal({
      code: 'quota_exceeded',
      message: 'the tenant has reached its connection quota',
      retryable: true,
      retryAfterMs: 1000,
      quota: 'connections',
      fatal: true,
    });
    expect(error.code).toBe('quota_exceeded');
    expect(error.details?.['quota']).toBe('connections');
  });
});
