/**
 * The regions the user cannot edit, as plain specs for the web view to shade and mark with a lock
 * indicator (PRM-026; 07 §7, first bullet). Which regions are locked is read from the access in
 * force and from nothing else (05 §5.5): a region whose scope lacks `edit`, which includes a region
 * the access does not list yet (PRM-006). With no access, no backend has told the core anything and
 * nothing is locked. A new access is a new answer, so the shading follows `perm.changed` without a
 * reload.
 *
 * The words of an indicator are the shell's, written with names from the host's directory, so the
 * core never sees a name (ui `CoreApi.setRegionLabels`). A locked region the shell gave no words for
 * takes a default: `unlisted` when the access does not list the region yet, otherwise `locked`.
 */
import type { Access } from '@docedit/protocol';
import type { Node } from 'prosemirror-model';
import { capsOf } from './guard.ts';

/** The words on the lock indicator of one region. */
export interface RegionLockLabel {
  /** Short and always visible, for example "Read-only". */
  readonly indicator: string;
  /** Who can edit the region, or why nobody can. Empty when the shell has nothing to say. */
  readonly description: string;
}

/** The words of a locked region that has none of its own. */
export interface RegionLockDefaults {
  /** A locked region the shell did not name (no region list, or the list is not read yet). */
  readonly locked?: RegionLockLabel;
  /** A region the access in force does not list yet (05 §5.5). */
  readonly unlisted?: RegionLockLabel;
}

/** One region the user cannot edit. */
export interface RegionLockSpec {
  /** The region's identifier. */
  readonly id: string;
  /** The position before the region node. */
  readonly from: number;
  /** The position after the region node. */
  readonly to: number;
  /** Whether the access in force does not list the region yet. */
  readonly unlisted: boolean;
  readonly label: RegionLockLabel;
}

/** English words, used until the shell sets its own (as the surfaces' names are, UX-064). */
export const DEFAULT_REGION_LOCK_LABEL: RegionLockLabel = {
  indicator: 'Read-only',
  description: '',
};

/**
 * The regions of `doc` the user cannot edit under `access`, in document order. Regions are direct
 * children of the body (I3). A region without an identifier is not a scope the access can name, so
 * it is left alone.
 */
export function regionLockSpecs(
  doc: Node,
  access: Access | null,
  labels: Readonly<Record<string, RegionLockLabel>> = {},
  defaults: RegionLockDefaults = {},
): RegionLockSpec[] {
  if (!access) return [];
  const body = doc.lastChild;
  if (!body || body.type.name !== 'body') return [];
  const out: RegionLockSpec[] = [];
  // The position before the body's first child.
  let pos = doc.content.size - body.nodeSize + 1;
  body.forEach((child) => {
    const from = pos;
    pos += child.nodeSize;
    if (child.type.name !== 'region') return;
    const id = child.attrs['id'];
    if (typeof id !== 'string' || id === '') return;
    const scope = `region:${id}`;
    if (capsOf(access, scope).includes('edit')) return;
    const unlisted = access.scopes[scope] === undefined;
    const label =
      (Object.hasOwn(labels, id) ? labels[id] : undefined) ??
      (unlisted ? defaults.unlisted : undefined) ??
      defaults.locked ??
      DEFAULT_REGION_LOCK_LABEL;
    out.push({ id, from, to: from + child.nodeSize, unlisted, label });
  });
  return out;
}
