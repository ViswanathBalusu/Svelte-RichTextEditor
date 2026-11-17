// PRO-035 criterion 6: the export names of the three vocabularies share their stems. The socket's
// notification types (05 §5.6) and the webhook names (05 §7) come from the protocol definition
// (DEP1); the DOM names are the ones `exportEvent` raises (PRO-086). Runs in Node.js.
import { DEP1, definition, type ExportJob } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { exportEvent } from '../src/export.ts';

const job = (state: ExportJob['state']): ExportJob =>
  ({ id: 'job-1', state, progress: null }) as unknown as ExportJob;

const notifications = new Set(DEP1.notifications.map((n) => n.type));
const webhooks = new Map(DEP1.webhooks.map((w) => [w.name, definition.webhookType(w)]));

describe('PRO-035 the export stems agree across notifications, webhooks and DOM events', () => {
  it('names the completed export dep.export.completed.v1 and de-export-completed', () => {
    expect(notifications.has('export.completed')).toBe(true);
    expect(webhooks.get('dep.export.completed')).toBe('dep.export.completed.v1');
    expect(exportEvent(job('completed')).name).toBe('de-export-completed');
  });

  it('names the failed export dep.export.failed.v1 and de-export-failed', () => {
    expect(notifications.has('export.failed')).toBe(true);
    expect(webhooks.get('dep.export.failed')).toBe('dep.export.failed.v1');
    expect(exportEvent(job('failed')).name).toBe('de-export-failed');
  });

  it('has a progress notice and a DOM event, and no webhook (a webhook reports an end)', () => {
    expect(notifications.has('export.progress')).toBe(true);
    expect(exportEvent(job('running')).name).toBe('de-export-progress');
    expect(webhooks.has('dep.export.progress')).toBe(false);
  });

  it('reports a cancelled job as a notification, and to the DOM as de-export-failed', () => {
    expect(notifications.has('export.cancelled')).toBe(true);
    expect(webhooks.has('dep.export.cancelled')).toBe(false);
    expect(exportEvent(job('cancelled')).name).toBe('de-export-failed');
  });

  it('gives every export notification a DOM name or a stated mapping, and no stray stem', () => {
    const stems = [...notifications].filter((t) => t.startsWith('export.')).map((t) => t.slice(7));
    expect(stems.sort()).toEqual(['cancelled', 'completed', 'failed', 'progress']);
    const webhookStems = [...webhooks.keys()]
      .filter((n) => n.startsWith('dep.export.'))
      .map((n) => n.slice('dep.export.'.length));
    expect(webhookStems.sort()).toEqual(['completed', 'failed']);
  });
});
