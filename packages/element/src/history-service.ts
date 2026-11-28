/**
 * The shell's history port over the backend's history port (05 §6.2; 08 §4; HIS-008; UX-097
 * criterion 5). The history pane reads the grouped commits and the named versions from here and
 * never calls the network; this file is the one place where the wire shape of
 * `GET /documents/{id}/history` meets the pane's.
 *
 * - The wire shape of a group is a proposed decision of the document service
 *   (`control-plane/history-list-route.ts`; `HistoryGroup` in the generated types is a placeholder,
 *   gap G67): `{ type: 'group', day, fromSeq, toSeq, fromTime, toTime, changes, authors, origins }`
 *   and `{ type: 'version', version }`. Anything that does not have that shape is left out.
 * - An author is the host's identifier for the person, as the service names them. The names come
 *   from `resolveUsers` (UX-025), which the pane calls with those identifiers.
 * - The port offers the list and its filters. Opening, comparing, restoring and naming a version
 *   are not given here (HIS-006, HIS-010, HIS-013, HIS-018): the pane offers only what the port has.
 */
import type { HistoryPort as WireHistoryPort } from '@docedit/protocol';
import type {
  HistoryChoices,
  HistoryPaneItem,
  HistoryPaneQuery,
  HistoryPaneResult,
  HistoryPort,
  ResolveUsers,
} from '@docedit/ui';

export interface HistorySource {
  readonly port: WireHistoryPort;
  readonly docId: string;
  /** The host's directory, read when the pane asks (it may be set after the editor is mounted). */
  readonly resolveUsers?: () => ResolveUsers | null;
}

const PAGE = 50;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One item of the wire list as the pane draws it, or null for one that is not of the known shape. */
export function paneItemOf(wire: unknown): HistoryPaneItem | null {
  if (!isObject(wire)) return null;
  if (wire['type'] === 'group') {
    const day = str(wire['day']);
    const fromTime = str(wire['fromTime']);
    const toTime = str(wire['toTime']);
    const fromSeq = num(wire['fromSeq']);
    const toSeq = num(wire['toSeq']);
    const changes = num(wire['changes']);
    if (day === null || fromTime === null || toTime === null) return null;
    if (fromSeq === null || toSeq === null || changes === null) return null;
    const authors: string[] = [];
    const assisted: Array<{ user: string; agent: string }> = [];
    const rawAuthors = Array.isArray(wire['authors']) ? (wire['authors'] as unknown[]) : [];
    for (const a of rawAuthors) {
      const user = isObject(a) ? str(a['user']) : null;
      if (user === null) continue;
      if (!authors.includes(user)) authors.push(user);
      const agent = isObject(a) ? str(a['agent']) : null;
      if (agent !== null) assisted.push({ user, agent });
    }
    const origins = Array.isArray(wire['origins'])
      ? (wire['origins'] as unknown[]).filter((o): o is string => typeof o === 'string')
      : [];
    return {
      kind: 'group',
      id: `g${fromSeq}-${toSeq}`,
      day,
      from: fromTime,
      to: toTime,
      authors,
      ...(assisted.length > 0 ? { assisted } : {}),
      changes,
      origins,
      toSeq,
    };
  }
  if (wire['type'] === 'version' && isObject(wire['version'])) {
    const v = wire['version'];
    const seq = num(v['seq']);
    const name = str(v['name']);
    const creator = str(v['createdBy']);
    const time = str(v['createdAt']);
    // Only a version the user named is listed as one; an export or a restore marker has no name.
    if (seq === null || name === null || creator === null || time === null) return null;
    const note = str(v['note']);
    return {
      kind: 'version',
      id: `v${seq}`,
      name,
      ...(note !== null ? { note } : {}),
      creator,
      time,
      seq,
    };
  }
  return null;
}

export function historyService(source: HistorySource): HistoryPort {
  const { port, docId } = source;
  const people = new Map<string, string>();
  return {
    async list(query: HistoryPaneQuery): Promise<HistoryPaneResult> {
      const page = await port.history(docId, {
        limit: PAGE,
        ...(query.namedOnly ? { namedOnly: true } : {}),
        ...(query.region !== null ? { region: query.region } : {}),
        ...(query.field !== null ? { field: query.field } : {}),
        ...(query.user !== null ? { user: query.user } : {}),
        ...(query.cursor !== null ? { cursor: query.cursor } : {}),
      });
      const items: HistoryPaneItem[] = [];
      for (const wire of page.items) {
        const item = paneItemOf(wire);
        if (item === null) continue;
        items.push(item);
        if (item.kind === 'group') for (const a of item.authors) people.set(a, a);
        else people.set(item.creator, item.creator);
      }
      return { items, nextCursor: page.nextCursor, namedOnly: query.namedOnly };
    },
    // The filters offer the people seen in the lists read so far; the regions and the fields of the
    // document come with the pane's own filters (HIS-009 criterion 2).
    async choices(): Promise<HistoryChoices> {
      return {
        regions: [],
        fields: [],
        people: [...people.keys()].map((id) => ({ id, label: people.get(id) ?? id })),
      };
    },
    ...(source.resolveUsers
      ? {
          resolveUsers: (ids: readonly string[]) =>
            source.resolveUsers?.()?.(ids) ?? Promise.resolve(ids.map(() => null)),
        }
      : {}),
  };
}
