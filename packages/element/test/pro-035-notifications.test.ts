// PRO-035 criterion 5: the client ignores an event type it does not know. The dispatcher is tested
// alone, and then in a session against the mock backend, whose channel carries the notice. Runs in
// Node.js.
import { DEP1, DEP1_WIRE_NOTIFICATION_TYPES, type Notification } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES,
  NotificationDispatcher,
} from '../src/notifications.ts';
import { Session } from '../src/session.ts';
import { backendFor, fakeEditor, recordingHost, service, settle } from './support.ts';

const notice = (type: string, extra: Partial<Notification> = {}): Notification =>
  ({ type, resource: '/documents/d-1', ...extra }) as Notification;

describe('NotificationDispatcher', () => {
  it('lists the types of the definition, with the ones of PRO-035', () => {
    for (const t of [
      'export.progress',
      'export.completed',
      'export.failed',
      'export.cancelled',
      'asset.ready',
      'asset.failed',
      'document.updated',
    ])
      expect(KNOWN_NOTIFICATION_TYPES.has(t), t).toBe(true);
  });

  it('repeats the names of the protocol definition exactly (FE-002: the entry does not load it)', () => {
    // The element keeps its own list so that its entry does not import the definition as data. A
    // type added to or removed from the definition must be added or removed there too.
    expect([...NOTIFICATION_TYPES]).toEqual([...DEP1_WIRE_NOTIFICATION_TYPES]);
    expect([...NOTIFICATION_TYPES]).toEqual(DEP1.notifications.map((n) => n.type));
    expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length);
    expect([...KNOWN_NOTIFICATION_TYPES]).toEqual([...NOTIFICATION_TYPES]);
  });

  it('hands a known notice to its handlers, unchanged and in order', () => {
    const d = new NotificationDispatcher();
    const seen: string[] = [];
    d.on('document.updated', (n) => seen.push(`a:${n.resource}:${n.rev}`));
    d.on('document.updated', (n) => seen.push(`b:${JSON.stringify(n.data)}`));
    expect(d.dispatch(notice('document.updated', { rev: 4, data: { x: 1 } }))).toBe(2);
    expect(seen).toEqual(['a:/documents/d-1:4', 'b:{"x":1}']);
  });

  it('ignores a type the definition does not list: no handler runs and nothing throws', () => {
    const d = new NotificationDispatcher();
    const seen: string[] = [];
    d.on('document.updated', (n) => seen.push(n.type));
    expect(d.dispatch(notice('x-future.thing.happened', { data: { a: 1 } }))).toBe(0);
    expect(seen).toEqual([]);
    // A known type nobody listens for is dropped the same way, and later notices still arrive.
    expect(d.dispatch(notice('asset.ready'))).toBe(0);
    expect(d.dispatch(notice('document.updated'))).toBe(1);
    expect(seen).toEqual(['document.updated']);
  });

  it('refuses to register for a type the definition does not list', () => {
    expect(() => new NotificationDispatcher().on('x-future.thing', () => {})).toThrow(RangeError);
  });

  it('keeps going when a handler throws, and reports it', () => {
    const errors: unknown[] = [];
    const d = new NotificationDispatcher({ onHandlerError: (e) => errors.push(e) });
    const seen: string[] = [];
    d.on('asset.failed', () => {
      throw new Error('boom');
    });
    d.on('asset.failed', (n) => seen.push(n.type));
    expect(() => d.dispatch(notice('asset.failed'))).not.toThrow();
    expect(seen).toEqual(['asset.failed']);
    expect(errors).toHaveLength(1);
  });

  it('stops delivering after the unsubscribe', () => {
    const d = new NotificationDispatcher();
    const seen: string[] = [];
    const off = d.on('asset.ready', (n) => seen.push(n.type));
    off();
    expect(d.dispatch(notice('asset.ready'))).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe('Session: event messages of the channel', () => {
  it('delivers a known event to its handler and ignores an unknown one, with the session still working', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: (run) => queueMicrotask(run),
    });
    await session.start();
    await settle();
    expect(session.phase).toBe('ready');
    const seen: string[] = [];
    session.notifications.on('document.updated', (n) => seen.push(n.resource));

    // The mock document sends `document.updated` to its attached channels on a state change.
    s.setDocumentState(docId, 'locked');
    await settle();
    expect(seen).toEqual([`/documents/${docId}`]);

    // An event of a type from a newer server: no handler, no error, no change of phase.
    const attached = (
      s.document(docId) as unknown as {
        attached: Map<string, { channel: { event(n: Notification): void } }>;
      }
    ).attached;
    expect(attached.size).toBeGreaterThan(0);
    const errorsBefore = host.events.filter((e) => e.name === 'de-error').length;
    for (const a of attached.values()) a.channel.event(notice('x-future.thing.happened'));
    await settle();
    expect(seen).toHaveLength(1);
    expect(session.phase).toBe('ready');
    expect(host.events.filter((e) => e.name === 'de-error')).toHaveLength(errorsBefore);

    // A later known event still arrives.
    s.setDocumentState(docId, 'active');
    await settle();
    expect(seen).toHaveLength(2);
    await session.close();
    await s.dispose();
  });
});
