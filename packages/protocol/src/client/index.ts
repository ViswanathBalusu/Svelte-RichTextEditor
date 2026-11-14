/**
 * `@docedit/protocol/client`: the client state machines of DEP (01 §6; PRO-004), shared by
 * `backend-dep`, the conformance kit and any other client. They do no I/O: a driver passes in
 * received frames and the time, and acts on what they return.
 *
 * - ClientSession: one connection, from `hello` to its end (05 §4, §5.1).
 * - ClientChannel: one document channel, its order of commits and its resume (05 §5.2 to §5.6;
 *   04 §8, §9).
 * - Negotiation (05 §1, §2) and reconnection (05 §4, §5.7).
 */
export {
  ClientSession,
  DEFAULT_HEARTBEAT_MS,
  type SessionInput,
  type SessionOptions,
  type SessionPhase,
} from './session.ts';
export {
  ClientChannel,
  DEFAULT_ANSWER_TIMEOUT_MS,
  RELOAD_REASON,
  type ChannelEffect,
  type ChannelOptions,
  type ChannelPhase,
  type SubmitHandle,
} from './channel.ts';
export {
  checkDiscovery,
  chooseCdm,
  chooseVersion,
  clientCapabilities,
  featureNamespaceProblems,
  isExperimental,
  negotiateFeatures,
  parseVersion,
  relayForbiddenAnnounced,
  subprotocolFor,
  type ClientCapabilities,
} from './negotiate.ts';
export {
  BACKOFF,
  backoffDelay,
  classifyClose,
  type BackoffPolicy,
  type CloseVerdict,
  type Reconnect,
} from './backoff.ts';
