/**
 * Types shared by the backend ports (05 §8.3; PRO-091). Every wire-level type is an alias of the
 * generated DEP types, so the ports cannot differ from the AsyncAPI, OpenAPI and JSON Schema
 * artifacts: they are generated from one definition and checked byte for byte in CI.
 *
 * No ProseMirror type appears in any port (PRO-091): documents are CDM JSON from `@docedit/model`,
 * steps are the JSON of `Step.toJSON()`.
 */
import type { CdmNode, DocNode } from '@docedit/model';
import type * as W from '../generated/types.ts';

/** Removes a callback registered with an `on…` member. Calling it twice is harmless. */
export type Unsubscribe = () => void;

/** The CDM node type that 05 §8.3 names for content (`doc: CdmNode`); content roots are `DocNode`. */
export type { CdmNode, DocNode };

/** A step commit as submitted (`sync.submit`). */
export type Commit = W.Commit;
/** A step: the JSON of `Step.toJSON()` (04 §4). */
export type Step = W.Step;
/** The acknowledgement of a commit (`sync.ack`). */
export type Ack = W.Ack;
/** The rejection of a commit (`sync.reject`). See SyncRejectError. */
export type SyncReject = W.SyncReject;
/** A stored commit as broadcast (`sync.commit` element). */
export type RemoteCommit = W.RemoteCommit;
/** Effective access (`ch.opened.access`, `perm.changed`). */
export type Access = W.Access;
/** A notification (`event`). */
export type Notification = W.Notification;
/** Where a channel resumes (`ch.open.resume`). */
export type Resume = W.Resume;
/** What `ch.opened` said (decision D20). */
export type ChannelOpened = W.ChannelOpened;
/** A snapshot commit was stored (`sync.reset`). */
export type SyncReset = W.SyncReset;
/** A divergence check (`sync.check`). */
export type SyncCheck = W.SyncCheck;
/** Content at a seq (`GET /documents/{id}/content`; decision D19). */
export type Content = W.Content;
/** Every limit a client must respect (`welcome.limits`). */
export type Limits = W.Limits;
/** The session accepted by the server (`welcome`). */
export type Session = W.Welcome;
export type ErrorCode = W.ErrorCode;
export type FeatureName = W.FeatureName;
export type Capability = W.Capability;
export type DocRole = W.DocRole;
export type ScopeId = W.ScopeId;

/**
 * The state of a channel (decision D20):
 * - `catching_up`: the server streams missed commits (`catchUp: "stream"`), until `sync.caughtUp`;
 * - `live`: caught up at `seq`, or opened with `page` (the backend pages for the caller) or `reload`;
 * - `resuming`: the backend lost the connection and reopens the channel with `resume`;
 * - `closed`: `ch.closed` from the server, a revocation, or `close()` (then `code` is null).
 */
export type ChannelState =
  | { status: 'catching_up'; head: number }
  | { status: 'live'; seq: number }
  | { status: 'resuming'; reason: string; retryInMs?: number }
  | { status: 'closed'; code: ErrorCode | null; reason: string; retryInMs?: number };

/** A resource with the `ETag` that a later update must send as `If-Match` (05 §6.1). */
export interface Tagged<T> {
  value: T;
  etag: string;
}

/** A cursor list (05 §6.1). */
export type Page<T> = W.List<T>;

/** A cancellation signal that does not depend on the DOM or Node.js (an AbortSignal adapts to it). */
export interface CancelSignal {
  readonly cancelled: boolean;
  onCancel(cb: () => void): Unsubscribe;
}

/** Request, query and response types of a REST operation, from the generated operation map. */
export type Query<K extends keyof W.Operations> = W.Operations[K]['query'];
export type Body<K extends keyof W.Operations> = W.Operations[K]['body'];
export type Response<K extends keyof W.Operations> = W.Operations[K]['response'];
