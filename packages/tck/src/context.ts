/**
 * The bootstrap (05 §11; PRO-108) and what a scenario works with. The kit reads discovery, checks
 * that its service credential can create a document and mint a token, and opens one probe session
 * for the limits `welcome` announces. A scenario then creates its own documents and users: every
 * `sub` carries the run's prefix, so runs against a shared tenant do not meet.
 */
import {
  DEP1,
  ShapeValidator,
  type Discovery,
  type DocRole,
  type Welcome,
} from '@docedit/protocol';
import type { CdmEnvelope } from '@docedit/model';
import { uuid7 } from '@docedit/model';
import { KitFailure, KitSkip, isObject, show } from './assert.ts';
import { discoveryUrl, type ResolvedConfig } from './config.ts';
import { Observed, operationOf } from './coverage.ts';
import { contractDocument } from './documents.ts';
import { responseProblems } from './registry-oracle.ts';
import { Http, ServiceClient, expectStatus, type GrantSpec } from './rest.ts';
import { Wire, type WireOptions } from './wire.ts';

/** What the context needs to know of its scenario (scenario.ts depends on this file, not back). */
export interface ScenarioRef {
  readonly id: string;
}

export const validator = new ShapeValidator(DEP1, { maxViolations: 16 });

/** Violations of a value against a named shape of the definition, as text. */
export function shapeViolations(name: string, value: unknown): string[] {
  return validator.checkNamed(name, value).map((v) => `${v.path || '/'} ${v.message}`);
}

export interface Target {
  readonly config: ResolvedConfig;
  readonly discoveryUrl: string;
  readonly discovery: Discovery;
  readonly features: ReadonlySet<string>;
  readonly http: Http;
  readonly service: ServiceClient;
  /** The `welcome` of the probe session: limits and features. */
  readonly welcome: Welcome;
}

export class BootstrapError extends Error {
  readonly expected: string | undefined;
  readonly received: string | undefined;
  constructor(message: string, expected?: unknown, received?: unknown) {
    super(message);
    this.name = 'BootstrapError';
    this.expected = expected === undefined ? undefined : show(expected);
    this.received = received === undefined ? undefined : show(received);
  }
}

export const HELLO_BASE = {
  versions: ['1.0'],
  client: { name: '@docedit/tck', version: '0.0.0' },
  engines: ['pm-steps/1'],
  cdm: { min: 1, max: 1 },
};

/** Reads discovery, checks the credential and opens a probe session (05 §11). */
export async function bootstrap(config: ResolvedConfig): Promise<Target> {
  const url = discoveryUrl(config.discovery);
  const http = new Http();
  let res;
  try {
    res = await http.request('GET', url);
  } catch (e) {
    throw new BootstrapError(`discovery at ${url} cannot be reached`, 'HTTP 200', String(e));
  }
  if (res.status !== 200 || !isObject(res.json))
    throw new BootstrapError(
      `discovery at ${url} answered ${res.status}`,
      'HTTP 200 with a JSON object',
      res.text,
    );
  const violations = shapeViolations('Discovery', res.json);
  const d = res.json as unknown as Discovery;
  if (typeof d.rest !== 'string' || typeof d.ws !== 'string' || !Array.isArray(d.features))
    throw new BootstrapError(
      'discovery has no usable rest, ws or features',
      'the members of 05 §2',
      violations,
    );
  const service = new ServiceClient(http, d.rest, config.credential);
  let doc: string;
  let token: string;
  try {
    doc = (await service.createDocument({ content: contractDocument() })).id;
    token = await service.token(`tck-${config.run}-probe`, { [doc]: 'viewer' });
  } catch (e) {
    throw new BootstrapError(
      'the service credential cannot create a document and mint a token (POST /documents, POST /tokens)',
      'HTTP 201 and 200',
      e instanceof KitFailure ? e.received : String(e),
    );
  }
  let wire: Wire;
  try {
    wire = await Wire.connect(d.ws, { label: 'probe', timeoutMs: config.timeoutMs });
  } catch (e) {
    throw new BootstrapError(
      `the WebSocket at ${d.ws} cannot be reached`,
      'a dep.v1 connection',
      String(e),
    );
  }
  try {
    const { reply } = await wire.request({ t: 'hello', d: { ...HELLO_BASE, token, features: [] } });
    if (reply.t !== 'welcome')
      throw new BootstrapError('the probe session was not welcomed', 'welcome', reply);
    return {
      config,
      discoveryUrl: url,
      discovery: d,
      features: new Set(d.features),
      http,
      service,
      welcome: reply.d,
    };
  } finally {
    await wire.close();
  }
}

/** What one scenario works with. */
export class ScenarioContext {
  readonly target: Target;
  readonly scenario: ScenarioRef;
  readonly notes: string[] = [];
  readonly observed = new Observed();
  readonly wires: Wire[] = [];
  /** REST problem documents the error registry does not allow (PRO-038). */
  readonly restProblems: string[] = [];
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private users = 0;
  private readonly stopObserving: () => void;

  constructor(target: Target, scenario: ScenarioRef) {
    this.target = target;
    this.scenario = scenario;
    this.stopObserving = target.http.observe((r) => {
      this.observed.operation(
        operationOf(r.method, r.url, target.discovery.rest),
        r.status,
        r.json,
      );
      // Every problem document is checked against the error registry (PRO-038).
      this.restProblems.push(...responseProblems(r, target.discovery.rest));
    });
  }

  get config(): ResolvedConfig {
    return this.target.config;
  }

  get service(): ServiceClient {
    return this.target.service;
  }

  get limits(): Welcome['limits'] {
    return this.target.welcome.limits;
  }

  get timeoutMs(): number {
    return this.target.config.timeoutMs;
  }

  /** Whether the server announces a feature (05 §1 rule 4). */
  has(feature: string): boolean {
    return this.target.features.has(feature);
  }

  skip(reason: string): never {
    throw new KitSkip(reason);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  defer(fn: () => Promise<void> | void): void {
    this.cleanups.push(fn);
  }

  /** A user identifier unique to this run and scenario. */
  sub(name: string): string {
    this.users += 1;
    return `tck-${this.config.run}-${this.scenario.id.replace(/[^a-zA-Z0-9]+/g, '-')}-${this.users}-${name}`;
  }

  /** A token for a new user (`POST /tokens`). */
  async token(
    name: string,
    docs: Readonly<Record<string, DocRole>>,
    extra: Record<string, unknown> = {},
  ) {
    const sub = this.sub(name);
    return { sub, token: await this.service.token(sub, docs, extra) };
  }

  /** A new document with CDM content (default: the contract document) and grants. */
  document(
    content: CdmEnvelope = contractDocument(),
    grants: readonly GrantSpec[] = [],
  ): Promise<string> {
    return this.service.document(content, grants);
  }

  /** A document identifier that no document has. */
  missingDocument(): string {
    return uuid7();
  }

  /** A WebSocket to the server's `ws` address. */
  async connect(opts: WireOptions = {}): Promise<Wire> {
    const wire = await Wire.connect(this.target.discovery.ws, {
      timeoutMs: this.timeoutMs,
      ...opts,
      observe: (dir, text, w) => {
        this.observed.text(text, dir);
        opts.observe?.(dir, text, w);
      },
    });
    this.wires.push(wire);
    return wire;
  }

  /** `hello` with a token; resolves the `welcome` or fails with what came instead. */
  async hello(wire: Wire, token: string, extra: Record<string, unknown> = {}): Promise<Welcome> {
    const { reply } = await wire.request({
      t: 'hello',
      d: { ...HELLO_BASE, token, features: this.clientFeatures(), ...extra },
    });
    if (reply.t !== 'welcome') throw new KitFailure('hello was not welcomed', 'welcome', reply);
    return reply.d;
  }

  /** The features the kit asks for: every feature the server announces that the kit knows. */
  clientFeatures(): string[] {
    const known = new Set(DEP1.features.map((f) => f.name));
    return [...this.target.features].filter((f) => known.has(f));
  }

  /** A connected, welcomed session for a new user with these roles. */
  async session(
    name: string,
    docs: Readonly<Record<string, DocRole>>,
    opts: { token?: Record<string, unknown>; wire?: WireOptions } = {},
  ) {
    const { sub, token } = await this.token(name, docs, opts.token);
    const wire = await this.connect({ label: name, ...opts.wire });
    const welcome = await this.hello(wire, token);
    return { sub, token, wire, welcome };
  }

  /** Records a close code the scenario provoked and checked. */
  closeCode(code: number): void {
    this.observed.closeCodes.add(code);
  }

  /**
   * Every frame the server sent on the scenario's connections that is not a valid message, and
   * every problem, on the socket or over REST, that the error registry does not allow (PRO-038).
   */
  problems(): string[] {
    return [
      ...this.wires.flatMap((w) => w.problems.map((p) => `${w.label}: ${p}`)),
      ...this.restProblems.map((p) => `rest: ${p}`),
    ];
  }

  async dispose(): Promise<void> {
    this.stopObserving();
    for (const fn of this.cleanups.reverse()) {
      try {
        await fn();
      } catch {
        // cleanup is best effort
      }
    }
    await Promise.all(this.wires.map((w) => w.close().catch(() => undefined)));
  }
}

/** A JSON body that must have succeeded. */
export { expectStatus };
