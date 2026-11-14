/**
 * The sync engines of a session (05 §5.1, §5.2; 04 §15; SYN-046 criterion 4). The server registers
 * the engines its settings name and that the authority defines; `hello.engines` is negotiated
 * against that registry once per session, and every `ch.open.engine` is decided against the
 * negotiated list by the authority's `negotiatedEngine`, before a room is acquired.
 */
import {
  EngineRegistry,
  PM_STEPS_1,
  negotiatedEngine,
  type EngineDecision,
  type EngineDefinition,
} from '@docedit/authority';

/** The engines the authority defines, by identifier. Only `pm-steps/1` in version 1. */
const DEFINED: ReadonlyMap<string, EngineDefinition> = new Map([
  [PM_STEPS_1.id, PM_STEPS_1 as EngineDefinition],
]);

/** A registry of the configured engines that the authority defines; others are left out. */
export function engineRegistry(configured: readonly string[]): EngineRegistry {
  const registry = new EngineRegistry();
  for (const id of configured) {
    const engine = DEFINED.get(id);
    if (engine) registry.register(engine);
  }
  return registry;
}

/** The engines of one session: negotiated from `hello.engines`, then used for every channel. */
export class SessionEngines {
  readonly #registry: EngineRegistry;
  #negotiated: readonly string[] = [];

  constructor(registry: EngineRegistry) {
    this.#registry = registry;
  }

  /** `hello.engines`: keeps the client's engines that the server also offers. */
  negotiate(offered: readonly unknown[]): readonly string[] {
    this.#negotiated = this.#registry.negotiate(Array.isArray(offered) ? offered : []);
    return this.#negotiated;
  }

  get negotiated(): readonly string[] {
    return this.#negotiated;
  }

  /** `ch.open.engine` against the negotiated list (`unsupported_engine` otherwise). */
  forChannel(engine: unknown): EngineDecision {
    return negotiatedEngine(this.#registry, engine, this.#negotiated);
  }
}
