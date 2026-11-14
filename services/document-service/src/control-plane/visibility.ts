/**
 * Read restrictions on the control plane (ADR 0019, proposed; S12; PLAN-1a "no packet may assume
 * readers see the whole document"). Content, field values, region titles, assets and exports are
 * read through one function per visibility class here, even while the classes are all the full
 * view: when the composition passes a `Visibility`, every REST read follows it.
 *
 * The class is derived from the permission data in storage at the time of the read (S12 change 3),
 * never from a cache, and the view token names it as the data plane does, so that a client can
 * resume a channel with the token of the content it read over REST (G101; decision D70).
 */
import {
  type Connection,
  type HiddenSet,
  NOTHING_HIDDEN,
  type PermissionState,
  type Visibility,
  project,
  viewToken,
  visibility as classVisibility,
  visibilityKey,
} from '@docedit/authority';
import type { JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';

export interface Views {
  /** What a reader may not see; absent: nothing is hidden. */
  readonly visibility?: Visibility;
  /** The token of a class; the data plane must compute the same (seams: `viewKey`). */
  token(hidden: HiddenSet): string;
}

/** The views of a deployment without read restrictions: every reader is in the full class. */
export const FULL_VIEWS: Views = { token: (h) => viewToken(visibilityKey(h)) };

/**
 * The views of a deployment with read restrictions on (ADR 0019; version 1 hides confidential
 * regions, owner decision of 2026-11-06): each reader's class comes from the permission data at the
 * time of the read, through the authority's visibility function, and `token` names the class.
 */
export function restrictedViews(now: () => number, token: (h: HiddenSet) => string): Views {
  return { visibility: classVisibility(now), token };
}

/** A reader's class: what is hidden from them and the token that names it. */
export interface ReaderView {
  hidden: HiddenSet;
  token: string;
  /** Whether nothing is hidden, so that reads may skip projecting. */
  full: boolean;
}

const isEmpty = (h: HiddenSet) => h.regions.size === 0 && h.values.size === 0;

/**
 * The class of `conn` for `doc` under `perms`. A service credential (`conn` null) reads the full
 * document: it acts for the tenant, and can mint a token for anyone.
 */
export function readerView(
  views: Views,
  conn: Connection | null,
  doc: JsonNode,
  perms: PermissionState,
): ReaderView {
  if (!conn || !views.visibility)
    return { hidden: NOTHING_HIDDEN, token: views.token(NOTHING_HIDDEN), full: true };
  const hidden = views.visibility(conn, cdmSchema().nodeFromJSON(doc), perms);
  return { hidden, token: views.token(hidden), full: isEmpty(hidden) };
}

/** Content as the class may see it (05 §6.2 content; BE-098). */
export function projectContent(view: ReaderView, doc: JsonNode): JsonNode {
  if (view.full) return doc;
  return project(cdmSchema().nodeFromJSON(doc), view.hidden).doc.toJSON() as JsonNode;
}

/** A region's title as the class may see it (05 §6.2 regions; ADR 0019 open question on titles). */
export function projectRegionTitle(view: ReaderView, region: string, title: string): string | null {
  if (view.full || !view.hidden.regions.has(region) || view.hidden.titles) return title;
  return null;
}

/** Whether the class may see a region at all in lists (it sees the placeholder of a hidden one). */
export function regionVisible(view: ReaderView, region: string): boolean {
  return view.full || !view.hidden.regions.has(region) || view.hidden.titles;
}

/** Field values as the class may see them (12 §3; ADR 0019). No field route exists in phase 1a. */
export function projectFieldValue(view: ReaderView, field: string, value: unknown): unknown {
  return view.full || !view.hidden.values.has(field) ? value : null;
}

/** Whether the class may read an asset (SR-C4: only through a scope it can see). */
export function assetVisible(view: ReaderView, scopes: readonly string[]): boolean {
  if (view.full) return true;
  return scopes.some((s) => !s.startsWith('region:') || !view.hidden.regions.has(s.slice(7)));
}

/**
 * What an export job records about its requester's class (EXP-123; SR-C4), so that the worker
 * builds the bundle from the requester's projection and its outputs stay with that class.
 */
export function exportView(view: ReaderView): {
  view: string;
  hiddenRegions: string[];
  hiddenValues: string[];
} {
  return {
    view: view.token,
    hiddenRegions: [...view.hidden.regions].sort(),
    hiddenValues: [...view.hidden.values].sort(),
  };
}
