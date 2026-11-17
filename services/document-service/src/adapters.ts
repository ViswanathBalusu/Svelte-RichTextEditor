/**
 * The adapter interfaces of 06 §14 (BE-002): the names the specification gives, and where each is
 * declared in this service. A self-hosted deployment swaps a part by giving `startService` another
 * implementation of the interface; rooms and handlers know only the interfaces.
 *
 * `Queue` is declared as `JobQueue`, the name the code had before the list was checked against
 * 06 §14. `Bus` has no interface yet: stage 1 has no bus (06 §1), and the shape of the stage 2 bus
 * waits for the choice of BE-059 (06 §16), so it is listed here as missing rather than guessed.
 */
export type { AssetStore, CheckpointStore, GrantStore, LogStore } from './storage/types.ts';
export type { KeyService } from './storage/key-service.ts';
export type { EventSink } from './control-plane/events.ts';
export type { JobQueue as Queue } from './control-plane/jobs/queue.ts';
export type { TokenVerifier } from './control-plane/tokens.ts';

/** Where each interface of 06 §14 is declared, relative to `src`; null where there is none yet. */
export const ADAPTER_INTERFACES: Readonly<
  Record<string, { readonly file: string; readonly declaredAs: string } | null>
> = {
  LogStore: { file: 'storage/types.ts', declaredAs: 'LogStore' },
  CheckpointStore: { file: 'storage/types.ts', declaredAs: 'CheckpointStore' },
  AssetStore: { file: 'storage/types.ts', declaredAs: 'AssetStore' },
  GrantStore: { file: 'storage/types.ts', declaredAs: 'GrantStore' },
  TokenVerifier: { file: 'control-plane/tokens.ts', declaredAs: 'TokenVerifier' },
  Queue: { file: 'control-plane/jobs/queue.ts', declaredAs: 'JobQueue' },
  Bus: null,
  EventSink: { file: 'control-plane/events.ts', declaredAs: 'EventSink' },
  KeyService: { file: 'storage/key-service.ts', declaredAs: 'KeyService' },
};
