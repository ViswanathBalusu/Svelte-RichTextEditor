/**
 * The classification view of the status bar (UX-085 criterion 2; PRO-048 criterion 2), over the
 * in-memory backend: the label is read from the document resource and follows `document.updated`
 * of the channel through the notification dispatcher.
 */
import { MockService } from '@docedit/backend-mock';
import { contractDocument } from '@docedit/protocol/contract';
import { describe, expect, it } from 'vitest';
import { classificationView } from './classification-shell.ts';
import { NotificationDispatcher } from './notifications.ts';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function setup() {
  const service = new MockService();
  const docId = service.createDocument(contractDocument());
  const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const notices = new NotificationDispatcher();
  channel.onEvent((n) => void notices.dispatch(n));
  const view = classificationView(backend.sync.document!.bind(backend.sync), docId, notices);
  return { service, docId, view, notices, backend };
}

describe('classificationView', () => {
  it('shows no label for a document without one, then the label the service set', async () => {
    const { service, docId, view } = await setup();
    let changes = 0;
    const stop = view.subscribe(() => (changes += 1));
    await settle();
    expect(view.get()).toBeNull();
    expect(changes).toBe(0);

    service.setClassification(docId, 'Internal use only');
    await settle();
    expect(view.get()).toEqual({ name: 'Internal use only' });
    expect(changes).toBe(1);

    service.setClassification(docId, 'Secret');
    await settle();
    expect(view.get()).toEqual({ name: 'Secret' });

    service.setClassification(docId, null);
    await settle();
    expect(view.get()).toBeNull();
    expect(changes).toBe(3);
    stop();
    await service.dispose();
  });

  it('reads the label already set when it is first watched', async () => {
    const { service, docId, view } = await setup();
    service.setClassification(docId, 'Confidential');
    const stop = view.subscribe(() => {});
    await settle();
    expect(view.get()).toEqual({ name: 'Confidential' });
    stop();
    await service.dispose();
  });

  it('ignores a notice for another document and a notice after the last watcher left', async () => {
    const { service, docId, view, notices } = await setup();
    const reads: string[] = [];
    const counted = classificationView(
      async (id) => {
        reads.push(id);
        return service.backend({ sub: 'eddie' }, { [docId]: 'editor' }).sync.document!(id);
      },
      docId,
      notices,
    );
    const stop = counted.subscribe(() => {});
    await settle();
    expect(reads).toEqual([docId]);

    notices.dispatch({ type: 'document.updated', resource: '/documents/other' });
    await settle();
    expect(reads).toEqual([docId]);

    stop();
    notices.dispatch({ type: 'document.updated', resource: `/documents/${docId}` });
    await settle();
    expect(reads).toEqual([docId]);
    void view;
    await service.dispose();
  });

  it('keeps the last label when a read fails', async () => {
    const notices = new NotificationDispatcher();
    let fail = false;
    const view = classificationView(
      async () => {
        if (fail) throw new Error('unavailable');
        return {
          etag: '"m1"',
          value: {
            id: 'd',
            externalId: null,
            title: null,
            properties: {},
            classification: 'Internal',
            state: 'active' as const,
            cdm: 1,
            requires: [],
            createdAt: '2026-11-18T10:00:00.000Z',
          },
        };
      },
      'd',
      notices,
    );
    const stop = view.subscribe(() => {});
    await settle();
    expect(view.get()).toEqual({ name: 'Internal' });
    fail = true;
    notices.dispatch({ type: 'document.updated', resource: '/documents/d' });
    await settle();
    expect(view.get()).toEqual({ name: 'Internal' });
    stop();
  });
});
