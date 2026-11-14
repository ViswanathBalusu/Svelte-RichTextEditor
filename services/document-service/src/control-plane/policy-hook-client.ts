/**
 * The sender of the data-loss prevention hook (UX-086 criterion 4; 13 section 10; 05 section 7).
 *
 * `policy-hook.ts` builds the signed request and reads the answer. This module sends it: one POST
 * to the tenant's hook URL, with a timeout, and it reports what happened as an outcome. The
 * outcome is `decided` with the hook's answer, or `unanswered` with a cause (`timeout`,
 * `unreachable` or `bad_answer`). The export route decides what an unanswered hook means (see
 * export-routes.ts and docs/adr/0330-lane-U-UX-076-090.md, section 4); this module decides nothing.
 *
 * The request is not followed to another address: a redirect is an error, so the hook is never
 * asked at an address the tenant did not register.
 *
 * Not built here: where a tenant registers its hook and its secrets (an open question). The
 * caller gives them to the constructor, as the server's parts do.
 */
import { randomUUID } from 'node:crypto';
import { type HookAction, type HookDecision, decisionOf, hookRequest } from './policy-hook.ts';

export interface PolicyHookConfig {
  /** The tenant's hook. Must be an http or https URL. */
  url: string;
  /** The tenant's active hook secrets: one while stable, two during a rotation. At least one. */
  secrets: readonly string[];
  /** The time to wait for an answer, in milliseconds: a whole number above 0. No default is set here. */
  timeoutMs: number;
  /** The clock, in Unix milliseconds. */
  now?: () => number;
  /** The transport. Defaults to the global `fetch`; a test may replace it. */
  fetch?: typeof fetch;
}

/** What the caller asks the hook about: the document, the acting user, the action, the target. */
export interface HookAsk {
  document: string;
  actor: string;
  action: HookAction;
  target: string;
  classification: string | null;
}

export type HookUnanswered = 'timeout' | 'unreachable' | 'bad_answer';

export type HookOutcome =
  { kind: 'decided'; decision: HookDecision } | { kind: 'unanswered'; cause: HookUnanswered };

/** Anything that can ask the hook. The export route depends on this, not on the sender. */
export interface PolicyHookGate {
  ask(input: HookAsk): Promise<HookOutcome>;
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

export class PolicyHookClient implements PolicyHookGate {
  readonly #config: PolicyHookConfig;

  constructor(config: PolicyHookConfig) {
    let protocol: string;
    try {
      protocol = new URL(config.url).protocol;
    } catch {
      throw new TypeError('the hook needs a URL');
    }
    if (protocol !== 'http:' && protocol !== 'https:')
      throw new TypeError('the hook URL is http or https');
    if (config.secrets.length === 0) throw new TypeError('the hook needs at least one secret');
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)
      throw new RangeError('the hook timeout is a whole number of milliseconds above 0');
    this.#config = config;
  }

  async ask(input: HookAsk): Promise<HookOutcome> {
    const now = this.#config.now ?? Date.now;
    const request = hookRequest({
      id: randomUUID(),
      timestamp: Math.floor(now() / 1000),
      secrets: this.#config.secrets,
      document: input.document,
      actor: input.actor,
      action: input.action,
      target: input.target,
      classification: input.classification,
    });
    const send = this.#config.fetch ?? fetch;
    try {
      const res = await send(this.#config.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#config.timeoutMs),
      });
      if (!res.ok) return { kind: 'unanswered', cause: 'bad_answer' };
      let answer: unknown;
      try {
        answer = await res.json();
      } catch (e) {
        // A body that is not JSON is a bad answer; a body cut off by the timeout is a timeout.
        if (isTimeout(e)) return { kind: 'unanswered', cause: 'timeout' };
        return { kind: 'unanswered', cause: 'bad_answer' };
      }
      const decision = decisionOf(answer);
      if (decision === null) return { kind: 'unanswered', cause: 'bad_answer' };
      return { kind: 'decided', decision };
    } catch (e) {
      return { kind: 'unanswered', cause: isTimeout(e) ? 'timeout' : 'unreachable' };
    }
  }
}
