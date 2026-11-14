// Switching off IP address and user agent capture (12 §7; FRW-042 criteria 1 to 3, decision level).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE_SETTINGS,
  captureChangeAudit,
  captureEvidence,
  settingsAt,
  type CaptureSettings,
} from '../src/workflow/capture.ts';

const off: CaptureSettings = { captureNetworkIdentity: false };
const on: CaptureSettings = { captureNetworkIdentity: true };
const ip = fc.stringMatching(/^10\.0\.[0-9]{1,3}\.[0-9]{1,3}$/);
const ua = fc.stringMatching(/^UA-[A-Za-z0-9 ./;()]{1,40}$/);
const items = fc.dictionary(
  fc.stringMatching(/^[a-z][a-zA-Z]{0,10}$/).filter((k) => k !== 'ipAddress' && k !== 'userAgent'),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
);

describe('with the setting off, no IP address and no user agent is stored (FRW-042 criterion 1)', () => {
  it('keeps the other items and drops the network identity (property)', () => {
    fc.assert(
      fc.property(items, ip, ua, (it0, address, agent) => {
        const out = captureEvidence({ items: it0, ipAddress: address, userAgent: agent }, off);
        expect(out).not.toHaveProperty('ipAddress');
        expect(out).not.toHaveProperty('userAgent');
        expect(out.items).toEqual(it0);
        expect(JSON.stringify(out)).not.toContain(address);
        expect(JSON.stringify(out)).not.toContain(agent);
      }),
    );
  });

  it('drops network keys a caller smuggles into the other items', () => {
    const out = captureEvidence(
      {
        items: { ipAddress: '10.0.0.1', userAgent: 'x', event: 'sign' },
        ipAddress: null,
        userAgent: null,
      },
      off,
    );
    expect(out.items).toEqual({ event: 'sign' });
  });
});

describe('with the setting on, both items are recorded (FRW-042 criterion 3)', () => {
  it('records the address and the agent with the other items (property)', () => {
    fc.assert(
      fc.property(items, ip, ua, (it0, address, agent) => {
        const out = captureEvidence({ items: it0, ipAddress: address, userAgent: agent }, on);
        expect(out.ipAddress).toBe(address);
        expect(out.userAgent).toBe(agent);
        expect(out.items).toEqual(it0);
      }),
    );
  });

  it('is the default for a tenant that never changed the setting', () => {
    expect(DEFAULT_CAPTURE_SETTINGS).toEqual(on);
  });
});

describe('a change of the setting applies to later events only (FRW-042 criterion 2)', () => {
  it('gives the setting in force at each instant, the latest change at or before it winning', () => {
    const changes = [
      { atMs: 300, settings: on },
      { atMs: 200, settings: off },
    ];
    expect(settingsAt(changes, 100)).toEqual(DEFAULT_CAPTURE_SETTINGS);
    expect(settingsAt(changes, 199)).toEqual(DEFAULT_CAPTURE_SETTINGS);
    expect(settingsAt(changes, 200)).toEqual(off);
    expect(settingsAt(changes, 299)).toEqual(off);
    expect(settingsAt(changes, 300)).toEqual(on);
  });

  it('later changes at the same instant win over earlier ones in the list (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), fc.boolean(), fc.boolean(), (at, a, b) => {
        const first: CaptureSettings = { captureNetworkIdentity: a };
        const second: CaptureSettings = { captureNetworkIdentity: b };
        expect(
          settingsAt(
            [
              { atMs: at, settings: first },
              { atMs: at, settings: second },
            ],
            at,
          ),
        ).toEqual(second);
      }),
    );
  });

  it('writes the audit entry with actor, time, and the old and new values', () => {
    expect(captureChangeAudit('admin_1', 500, on, off)).toEqual({
      kind: 'capture.setting.changed',
      actor: 'admin_1',
      atMs: 500,
      from: on,
      to: off,
    });
    expect(() => captureChangeAudit('', 500, on, off)).toThrow(RangeError);
  });
});
