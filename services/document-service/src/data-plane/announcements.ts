/**
 * Announcements between nodes (BE-063 criterion 5; BE-026; 06 §3). A change of grants, of a
 * document or of a workflow is written to storage first. The node that wrote it then tells the
 * owning room, which may be on another node, by a message on the bus. The message is a hint to
 * read again: it carries the document, not the new state, and a node that hears it reads the state
 * from storage.
 *
 * The message may be lost. Correctness does not depend on it: the room's write is conditional on
 * the grant revision (BE-026), so a commit checked against grants that were replaced is refused and
 * the room reloads them; a channel that opens reads the stored permission state; and the log is
 * written before an acknowledgement. A lost announcement therefore delays `perm.changed` and costs
 * a refused commit, never a commit stored under an old revision.
 */
import type { PermissionState, WorkflowRecord } from '@docedit/authority';
import type { RoomNotifier } from '../seams.ts';
import type { DocRef, GrantStore } from '../storage/types.ts';
import type { Bus, Subscription } from './bus.ts';

const TOPIC = 'announce';

type Announcement =
  | { readonly k: 'permissions'; readonly ref: DocRef }
  | { readonly k: 'document'; readonly ref: DocRef }
  | {
      readonly k: 'workflow';
      readonly ref: DocRef;
      readonly record: WorkflowRecord;
      readonly withPerms: boolean;
    };

/** A notifier that tells the local rooms and then announces the change to the other nodes. */
export class AnnouncingNotifier implements RoomNotifier {
  readonly #local: RoomNotifier;
  readonly #bus: Bus;

  constructor(local: RoomNotifier, bus: Bus) {
    this.#local = local;
    this.#bus = bus;
  }

  #announce(a: Announcement): void {
    void this.#bus.publish(TOPIC, JSON.stringify(a));
  }

  permissionsChanged(ref: DocRef, perms: PermissionState): void {
    this.#local.permissionsChanged(ref, perms);
    this.#announce({ k: 'permissions', ref });
  }

  documentChanged(ref: DocRef): void {
    this.#local.documentChanged(ref);
    this.#announce({ k: 'document', ref });
  }

  workflowChanged(ref: DocRef, record: WorkflowRecord, perms?: PermissionState): void {
    this.#local.workflowChanged?.(ref, record, perms);
    this.#announce({ k: 'workflow', ref, record, withPerms: perms !== undefined });
  }
}

/**
 * Applies the announcements of other nodes to this node's rooms. A node that has no room for the
 * document ignores them. Resolves once announcements published from now on are heard.
 */
export function listenForAnnouncements(
  bus: Bus,
  node: string,
  local: RoomNotifier,
  grants: Pick<GrantStore, 'current'>,
  onError: (e: unknown, where: string) => void,
): Promise<Subscription> {
  return bus.subscribe(TOPIC, (m) => {
    if (m.from === node) return;
    void (async () => {
      let a: Announcement;
      try {
        a = JSON.parse(m.body) as Announcement;
      } catch {
        return;
      }
      if (a.k === 'document') return local.documentChanged(a.ref);
      const perms = await grants.current(a.ref);
      if (a.k === 'permissions') return local.permissionsChanged(a.ref, perms);
      local.workflowChanged?.(a.ref, a.record, a.withPerms ? perms : undefined);
    })().catch((e: unknown) => onError(e, 'announcement'));
  });
}
