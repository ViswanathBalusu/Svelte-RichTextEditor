/**
 * `@docedit/protocol`: the Document Editing Protocol as code (05; SPK-019).
 *
 * - The definition of DEP 1.0 as data (`DEP1`), from which the types, the AsyncAPI, OpenAPI and
 *   JSON Schema artifacts under spec/dep and the codec are generated.
 * - The generated wire types (src/generated/types.ts); the port types are aliases of them.
 * - Codecs: text frames with validation, chunking, binary frames.
 * - The backend ports and their shared types and errors.
 *
 * The reusable port contract suite is `@docedit/protocol/contract`; the translation of the
 * authority's in-process messages into DEP payloads is `@docedit/protocol/bridge`. Universal: no
 * Node.js or browser API (FND-004).
 */
export type * from './generated/types.ts';
export * as definition from './definition/index.ts';
export {
  DEP1,
  checkDefinition,
  defineDep,
  type DepDefinition,
  type DepExtension,
} from './definition/index.ts';
export * from './codec/index.ts';
export type {
  Body,
  CancelSignal,
  CdmNode,
  ChannelState,
  DocNode,
  Page,
  Query,
  Response,
  Session,
  Tagged,
  Unsubscribe,
} from './ports/types.ts';
export type {
  AuthPort,
  Backend,
  PermissionsPort,
  SyncChannel,
  SyncPort,
  TokenSource,
} from './ports/core.ts';
export type * from './ports/optional.ts';
export type * from './ports/host.ts';
export {
  OPTIONAL_PORTS,
  OrderedDelivery,
  PORT_FEATURES,
  PortError,
  SyncRejectError,
  hasPort,
  isPortError,
  isSyncReject,
  portFeatureMismatches,
  type OptionalPortName,
} from './ports/index.ts';
