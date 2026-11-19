// PRM-043 criterion 7 at the element (lane w5): the shell gets a check-out service only when the
// backend announces `leases` and has the port, and the service follows the leases the session took.
// Node.js only; the port is a stand-in for `backend-dep`'s, which has its own tests (PRO-053, PRO-097).
import type { LeasesPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { leasesFor, leasesService } from '../src/lease-shell.ts';

function port() {
  const calls: string[] = [];
  const fake: LeasesPort = {
    acquire: async (doc, region) => {
      calls.push(`acquire ${doc} ${region}`);
      return {
        value: { id: `lease-${region}`, holder: 'alice', expiresAt: '2026-11-18T10:05:00.000Z' },
        etag: `"lease-${region}"`,
      };
    },
    heartbeat: async () => {
      throw new Error('the service sends no heartbeats; the port does');
    },
    release: async (doc, region) => {
      calls.push(`release ${doc} ${region}`);
    },
  };
  return { fake, calls };
}

describe('the element offers check-out only where the backend announces leases', () => {
  it('gives no service to a backend that does not announce leases', () => {
    const { fake } = port();
    expect(
      leasesFor({ leases: fake, features: new Set(['presence', 'regions']) }, 'd1'),
    ).toBeNull();
  });

  it('gives no service to a backend that announces leases but has no port', () => {
    expect(leasesFor({ features: new Set(['leases']) }, 'd1')).toBeNull();
    expect(leasesFor(null, 'd1')).toBeNull();
    expect(leasesFor(undefined, 'd1')).toBeNull();
  });

  it('gives a service to a backend that announces leases and has the port', () => {
    const { fake } = port();
    expect(leasesFor({ leases: fake, features: new Set(['leases']) }, 'd1')).not.toBeNull();
  });
});

describe('the check-out service', () => {
  it('takes a lease through the port and lists it until it is released', async () => {
    const { fake, calls } = port();
    const service = leasesService(fake, 'd1');
    let notified = 0;
    const stop = service.held.subscribe(() => (notified += 1));
    expect(service.held.get()).toEqual([]);

    const lease = await service.acquire('r1');
    expect(lease).toEqual({
      region: 'r1',
      holder: 'alice',
      expiresAt: '2026-11-18T10:05:00.000Z',
    });
    expect(service.held.get()).toEqual([lease]);

    await service.release('r1');
    expect(service.held.get()).toEqual([]);
    expect(calls).toEqual(['acquire d1 r1', 'release d1 r1']);
    expect(notified).toBe(2);
    stop();
  });

  it('keeps the list as it was when the port refuses', async () => {
    const { fake } = port();
    const refusing: LeasesPort = {
      ...fake,
      acquire: async () => {
        throw Object.assign(new Error('another user holds it'), { code: 'conflict' });
      },
    };
    const service = leasesService(refusing, 'd1');
    await expect(service.acquire('r1')).rejects.toMatchObject({ code: 'conflict' });
    expect(service.held.get()).toEqual([]);
  });
});
