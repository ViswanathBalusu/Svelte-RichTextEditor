/**
 * The kit's inputs (05 §11 bootstrap contract; PRO-108): a discovery URL, a service credential and
 * the state of the server's test-mode switch. Everything else is optional and has a default; the
 * optional inputs widen what the kit can check, and a scenario that needs a missing one is skipped
 * with the reason (ADR 0042).
 */
import type { ReceiverOptions } from './receiver.ts';

/**
 * The authority service the `authority-service` profile runs against (05 §10, §11; PRO-125). It is
 * not a DEP server, so it has an address of its own. A run may name it with or without a discovery URL.
 */
export interface AuthorityServiceInput {
  /** The service's base URL, without the `/v1/authority` path. */
  url: string;
  /** The bearer token its calls need, when the operator set one. */
  token?: string;
  /**
   * Restarts the service and returns its new URL when that changed. Only a caller that controls the
   * service can give it (the kit's own tests do); without it the restart scenario is skipped.
   */
  restart?: () => Promise<string | undefined>;
}

export interface KitConfig {
  /**
   * `{endpoint}/.well-known/dep`, or the endpoint itself. Empty when the run is for the authority
   * service alone: every DEP profile is then skipped.
   */
  discovery: string;
  /** A service credential of the tenant the kit may use (05 §3.2). */
  credential: string;
  /** Whether the server runs with its test-mode switch on (05 §11; PRO-109). */
  testMode: boolean;
  /**
   * An origin registered for the kit's tenant. Without it the CORS scenarios and the allowed-origin
   * half of the `Origin` check are skipped.
   */
  origin?: string;
  /**
   * A service credential of a second tenant (UX-076). With it the kit also checks that a caller of
   * another tenant sees, changes and opens nothing of the kit's tenant; without it those scenarios
   * are skipped with the reason. It must never be the kit tenant's own credential.
   */
  otherCredential?: string;
  /** The authority service for the `authority-service` profile; without it the profile is skipped. */
  authorityService?: AuthorityServiceInput;
  /**
   * Where the kit's webhook receiver listens and the URL the target reaches it at (PRO-121). The
   * target refuses private and loopback addresses (10 §3.2), so a run that needs them names a public
   * URL, or the server is started in test mode with the receiver's address allowed.
   */
  receiver?: ReceiverOptions;
  /** Run only these profiles (default: all of them). */
  profiles?: readonly string[];
  /** Run only scenarios whose identifier starts with one of these. */
  scenarios?: readonly string[];
  /** How long to wait for one expected message or response (default 10 s). */
  timeoutMs?: number;
  /** How long one scenario may take (default 60 s). */
  scenarioTimeoutMs?: number;
  /** Fuzzing: a time budget per fuzzer and a seed (default: 20 s, a seed drawn and reported). */
  fuzz?: { budgetMs?: number; seed?: number; maxRuns?: number };
  /** Property tests: runs and seed (default 25 runs, a seed drawn and reported). */
  property?: { runs?: number; seed?: number };
  /**
   * The history visibility the target applies (07 §8). The viewer catch-up case depends on the
   * default `editors` (ADR 0034, proposed); with another setting it is skipped.
   */
  historyVisibility?: string;
  /**
   * The feature name that announces read restrictions (ADR 0019). DEP has none yet (gap G101,
   * PRO-130); the kit's proposal is `read-restrictions` (ADR 0042).
   */
  readRestrictionsFeature?: string;
  /** A prefix for the users the kit creates, unique per run (default: drawn). */
  run?: string;
  /** Progress lines. */
  log?: (line: string) => void;
}

export interface ResolvedConfig extends Required<
  Omit<
    KitConfig,
    | 'origin'
    | 'otherCredential'
    | 'profiles'
    | 'scenarios'
    | 'fuzz'
    | 'property'
    | 'authorityService'
    | 'receiver'
  >
> {
  origin: string | undefined;
  otherCredential: string | undefined;
  receiver: ReceiverOptions | undefined;
  authorityService: AuthorityServiceInput | undefined;
  profiles: readonly string[] | undefined;
  scenarios: readonly string[] | undefined;
  fuzz: { budgetMs: number; seed: number; maxRuns: number };
  property: { runs: number; seed: number };
}

const drawn = (): number => Math.floor(Math.random() * 2 ** 31);

export function resolveConfig(c: KitConfig): ResolvedConfig {
  return {
    discovery: c.discovery,
    credential: c.credential,
    testMode: c.testMode,
    origin: c.origin,
    otherCredential: c.otherCredential,
    receiver: c.receiver,
    authorityService: c.authorityService,
    profiles: c.profiles,
    scenarios: c.scenarios,
    timeoutMs: c.timeoutMs ?? 10_000,
    scenarioTimeoutMs: c.scenarioTimeoutMs ?? 60_000,
    fuzz: {
      budgetMs: c.fuzz?.budgetMs ?? 20_000,
      seed: c.fuzz?.seed ?? drawn(),
      maxRuns: c.fuzz?.maxRuns ?? 100_000,
    },
    property: { runs: c.property?.runs ?? 25, seed: c.property?.seed ?? drawn() },
    historyVisibility: c.historyVisibility ?? 'editors',
    readRestrictionsFeature: c.readRestrictionsFeature ?? 'read-restrictions',
    run: c.run ?? Math.random().toString(36).slice(2, 8),
    log: c.log ?? (() => {}),
  };
}

/** The discovery URL for an endpoint or a discovery URL (05 §2). */
export function discoveryUrl(input: string): string {
  const u = new URL(input);
  if (u.pathname.endsWith('/.well-known/dep')) return u.toString();
  return `${u.toString().replace(/\/$/, '')}/.well-known/dep`;
}
