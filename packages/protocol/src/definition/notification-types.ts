/**
 * The notification types of DEP 1.0 with the additions of 12 §10, as plain names. The element's
 * dispatcher needs only these names, and a module of its own keeps the whole definition (the shapes,
 * the messages, the REST resources) out of the first interactive bundle (FND-008; owner decision 32).
 *
 * `wire.test.ts` checks that this list equals the types in `DEP1`, in the same order.
 */
export const DEP1_WIRE_NOTIFICATION_TYPES: readonly string[] = [
  'thread.created',
  'thread.updated',
  'thread.resolved',
  'thread.reopened',
  'thread.deleted',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'version.created',
  'version.restored',
  'export.progress',
  'export.completed',
  'export.failed',
  'export.cancelled',
  'import.completed',
  'import.failed',
  'asset.ready',
  'asset.failed',
  'document.updated',
];
