// The send service reports the `sentSeq` of the workflow resource (FRW-033 criterion 5: the copy a
// declined or voided workflow offers starts from the document as it was sent). Node.js, a stand-in port.
import { DocumentCore } from '@docedit/engine/headless';
import type { EditorCore } from '@docedit/engine';
import { PortError, type WorkflowPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { workflowSendService } from '../src/workflow-send.ts';
import { fieldsDocument } from '../../engine/test/frw-fields-fixture.ts';

type Resource = Awaited<ReturnType<WorkflowPort['get']>>['value'];

const schedule = (run: () => void): void => queueMicrotask(run);

function setup(read: () => Resource) {
  const port: Pick<WorkflowPort, 'get' | 'act'> = {
    get: async () => ({ value: read(), etag: '"1"' }) as Awaited<ReturnType<WorkflowPort['get']>>,
    act: async () => {
      throw new PortError('forbidden', 'no');
    },
  };
  const core = new DocumentCore({ doc: fieldsDocument(), schedule });
  return workflowSendService(core as unknown as EditorCore, () => ({ port, docId: 'd1' }));
}

const resource = (state: string, sentSeq?: number): Resource =>
  ({
    id: 'w1',
    doc: 'd1',
    state,
    rev: 1,
    timeZone: 'UTC',
    participants: [],
    ...(sentSeq !== undefined ? { sentSeq } : {}),
  }) as unknown as Resource;

describe('the send service reports sentSeq (FRW-033 criterion 5)', () => {
  it('is null until the resource is read and for a draft, then the sequence the document was sent at', async () => {
    let current = resource('draft');
    const send = setup(() => current);
    expect(send.sentSeq?.get()).toBeNull();
    await send.refresh();
    expect(send.sentSeq?.get()).toBeNull();

    let heard = 0;
    send.sentSeq?.subscribe(() => heard++);
    current = resource('declined', 7);
    await send.refresh();
    expect(send.sentSeq?.get()).toBe(7);
    expect(heard).toBe(1);
    // The same value again is not a change; seq 0 is a value, not an absence.
    await send.refresh();
    expect(heard).toBe(1);
    current = resource('voided', 0);
    await send.refresh();
    expect(send.sentSeq?.get()).toBe(0);
    expect(heard).toBe(2);
  });
});
