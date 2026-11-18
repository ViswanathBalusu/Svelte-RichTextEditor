/**
 * `@docedit/authority-service`: the authority package behind a network interface (05 §10).
 */
export {
  AuthorityService,
  DEFAULT_CAPACITY,
  fail,
  type Answer,
  type CheckpointRef,
  type CheckpointResolver,
  type MaterialiseAnswer,
  type OpenAnswer,
  type OpenRequest,
  type ServiceError,
  type ServiceErrorCode,
  type ServiceOptions,
  type WireCommit,
  type WirePayload,
} from './service.ts';
export {
  IMPLEMENTED_CALLS,
  capabilities,
  sidecarProblems,
  type Capabilities,
} from './capabilities.ts';
export {
  API,
  DEFAULT_MAX_BODY,
  STATUS,
  listen,
  parseBody,
  problem,
  route,
  type HttpRequest,
  type HttpResponse,
  type RunningServer,
  type Routes,
  type ServerOptions,
} from './http.ts';
