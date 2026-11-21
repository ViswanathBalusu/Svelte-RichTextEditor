/**
 * The adapter interfaces of 06 §14 (BE-002): the names the specification gives, and where each is
 * declared in this service. A self-hosted deployment swaps a part by giving `startService` another
 * implementation of the interface; rooms and handlers know only the interfaces.
 *
 * `Queue` is declared as `JobQueue`, the name the code had before the list was checked against
 * 06 §14. `Bus` is the internal bus between nodes of stage 2 (06 §4.3): stage 1 has none (06 §1),
 * and the adapter of the reference distribution is Valkey streams (owner decision 136; ADR 0243),
 * in `data-plane/valkey-bus.ts`.
 */
export type { AssetStore, CheckpointStore, GrantStore, LogStore } from './storage/types.ts';
export type { KeyService } from './storage/key-service.ts';
export type { EventSink } from './control-plane/events.ts';
export type { JobQueue as Queue } from './control-plane/jobs/queue.ts';
export type { TokenVerifier } from './control-plane/tokens.ts';
export type { Bus } from './data-plane/bus.ts';

/** Where each interface of 06 §14 is declared, relative to `src`. */
export const ADAPTER_INTERFACES: Readonly<
  Record<string, { readonly file: string; readonly declaredAs: string }>
> = {
  LogStore: { file: 'storage/types.ts', declaredAs: 'LogStore' },
  CheckpointStore: { file: 'storage/types.ts', declaredAs: 'CheckpointStore' },
  AssetStore: { file: 'storage/types.ts', declaredAs: 'AssetStore' },
  GrantStore: { file: 'storage/types.ts', declaredAs: 'GrantStore' },
  TokenVerifier: { file: 'control-plane/tokens.ts', declaredAs: 'TokenVerifier' },
  Queue: { file: 'control-plane/jobs/queue.ts', declaredAs: 'JobQueue' },
  Bus: { file: 'data-plane/bus.ts', declaredAs: 'Bus' },
  EventSink: { file: 'control-plane/events.ts', declaredAs: 'EventSink' },
  KeyService: { file: 'storage/key-service.ts', declaredAs: 'KeyService' },
};
