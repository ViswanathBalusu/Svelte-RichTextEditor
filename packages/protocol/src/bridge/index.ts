/**
 * `@docedit/protocol/bridge`: the authority's in-process messages as DEP payloads (05 §5; S6
 * report, section 6). Used by `backend-mock` and by the document service's data plane, so that both
 * put the room on the wire the same way. A subpath of its own because it depends on
 * `@docedit/authority`, which the rest of the protocol package does not need.
 */
export {
  regionKey,
  storiesOf,
  toAccess,
  toAck,
  toReject,
  toRemoteCommit,
  toScopes,
  type RoomDocument,
} from './translate.ts';
export { CommitCoalescer, checkWindow } from './coalesce.ts';
export {
  RoomBridge,
  closeReasonText,
  type BridgeSource,
  type DepEvent,
  type DepOutbound,
  type RoomBridgeOptions,
  type RoomOpened,
  type TranslateOptions,
} from './room-bridge.ts';
