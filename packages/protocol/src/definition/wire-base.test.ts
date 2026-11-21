/**
 * FND-008: the client starts from a smaller definition (`DEP1_WIRE_BASE`) and loads the shapes of
 * the control plane's resources with the first check that names one (`loadWireMoreShapes`,
 * `ShapeValidator.ensure`). The base and what is loaded must together be what `DEP1_WIRE` is, and
 * the base must be closed: what the channel's messages and the base shapes name, the base has.
 */
import { describe, expect, it } from 'vitest';
import { ShapeValidator } from '../codec/validate.ts';
import { DEP1_WIRE, DEP1_WIRE_BASE, loadWireMoreShapes } from './wire.ts';

/** The names a value of the definition refers to, at any depth. */
function refsOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) refsOf(v, out);
  else if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o['kind'] === 'ref' && typeof o['name'] === 'string') out.add(o['name']);
    for (const v of Object.values(o)) refsOf(v, out);
  }
  return out;
}

describe('the base definition of a client (FND-008)', () => {
  it('has the version, engines, CDM range, messages and features of the whole', () => {
    expect(DEP1_WIRE_BASE.version).toBe(DEP1_WIRE.version);
    expect(DEP1_WIRE_BASE.engines).toEqual(DEP1_WIRE.engines);
    expect(DEP1_WIRE_BASE.cdm).toEqual(DEP1_WIRE.cdm);
    expect(DEP1_WIRE_BASE.messages).toEqual(DEP1_WIRE.messages);
    expect(DEP1_WIRE_BASE.features).toEqual(DEP1_WIRE.features);
  });

  it('with the shapes it loads, holds the shapes of the whole, in the same order', async () => {
    const more = await loadWireMoreShapes();
    expect([...DEP1_WIRE_BASE.shapes, ...more]).toEqual(DEP1_WIRE.shapes);
    expect(more.length).toBeGreaterThan(0);
  });

  it('is closed: every shape the messages and the base shapes name is in the base', () => {
    const names = new Set(DEP1_WIRE_BASE.shapes.map((s) => s.name));
    const named = refsOf([DEP1_WIRE_BASE.messages, DEP1_WIRE_BASE.shapes]);
    const missing = [...named].filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });

  it('leaves out the control plane: a shape of a resource is not in the base', () => {
    const names = new Set(DEP1_WIRE_BASE.shapes.map((s) => s.name));
    for (const name of ['TokenRequest', 'CreateExportRequest', 'Workflow', 'RetentionPolicy'])
      expect(names.has(name)).toBe(false);
    // The body of a webhook goes to a host's server, never to a client, so it is not in the base
    // either (FND-008); the notification names are.
    expect(names.has('WebhookDelivery')).toBe(false);
    expect(names.has('NotificationType')).toBe(true);
    // The shapes the first load needs are there.
    for (const name of ['Discovery', 'Content', 'RemoteCommit']) expect(names.has(name)).toBe(true);
  });
});

describe('a validator that loads the shapes left out (FND-008)', () => {
  const DOC = '01890a5d-ac96-774b-bcce-b302099a8057';
  const body = { sub: 'ada', docs: { [DOC]: 'editor' } };

  it('does not know a shape of a resource until it is asked to ensure it', async () => {
    let loads = 0;
    const v = new ShapeValidator(DEP1_WIRE_BASE, {
      more: () => {
        loads++;
        return loadWireMoreShapes();
      },
    });
    expect(v.checkNamed('TokenRequest', body)).toEqual([
      { path: '', message: 'unknown shape TokenRequest' },
    ]);
    await Promise.all([v.ensure('TokenRequest'), v.ensure('Thread')]);
    expect(loads).toBe(1);
    expect(v.checkNamed('TokenRequest', body)).toEqual([]);
    expect(v.checkNamed('TokenRequest', { sub: 1 }).length).toBeGreaterThan(0);
    // Nothing more is loaded for a shape the validator has.
    await v.ensure('Discovery');
    expect(loads).toBe(1);
  });

  it('loads the shape of a webhook body on first use and checks it as the whole does', async () => {
    const lazy = new ShapeValidator(DEP1_WIRE_BASE, { more: loadWireMoreShapes });
    const whole = new ShapeValidator(DEP1_WIRE);
    const event = {
      specversion: '1.0',
      id: 'evt-1',
      source: '/documents',
      type: 'dep.export.completed.v1',
      subject: DOC,
      data: { seq: 3 },
    };
    expect(lazy.checkNamed('WebhookDelivery', event)).toEqual([
      { path: '', message: 'unknown shape WebhookDelivery' },
    ]);
    await lazy.ensure('WebhookDelivery');
    for (const value of [event, { ...event, specversion: '2.0' }, { ...event, data: {} }, null]) {
      expect(lazy.checkNamed('WebhookDelivery', value)).toEqual(
        whole.checkNamed('WebhookDelivery', value),
      );
    }
    expect(lazy.checkNamed('WebhookDelivery', event)).toEqual([]);
    expect(lazy.checkNamed('WebhookDelivery', { ...event, specversion: '2.0' }).length).toBe(1);
  });

  it('gives the verdict of a validator made from the whole definition', async () => {
    const whole = new ShapeValidator(DEP1_WIRE);
    const lazy = new ShapeValidator(DEP1_WIRE_BASE, { more: loadWireMoreShapes });
    for (const value of [body, { sub: 1 }, {}, null, { sub: 'ada', docs: { [DOC]: 'nobody' } }]) {
      await lazy.ensure('TokenRequest');
      expect(lazy.checkNamed('TokenRequest', value)).toEqual(
        whole.checkNamed('TokenRequest', value),
      );
    }
  });

  it('asks again after a load fails, and keeps unknown a name nobody gives', async () => {
    let calls = 0;
    const v = new ShapeValidator(DEP1_WIRE_BASE, {
      more: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error('offline')) : loadWireMoreShapes();
      },
    });
    await expect(v.ensure('TokenRequest')).rejects.toThrow('offline');
    await v.ensure('TokenRequest');
    expect(v.checkNamed('TokenRequest', body)).toEqual([]);
    await v.ensure('NoSuchShape');
    expect(v.checkNamed('NoSuchShape', {})).toEqual([
      { path: '', message: 'unknown shape NoSuchShape' },
    ]);
  });

  it('is a plain validator when it has no loader', async () => {
    const v = new ShapeValidator(DEP1_WIRE_BASE);
    await v.ensure('TokenRequest');
    expect(v.checkNamed('TokenRequest', body)).toEqual([
      { path: '', message: 'unknown shape TokenRequest' },
    ]);
  });
});
