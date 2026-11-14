/**
 * The page glue of the reference host (13 §11.1 item 2; UX-093): what a host page writes around
 * `<doc-editor>`, using only the element's attributes, properties, methods and events (05 §8.1).
 * Framework-free on purpose: copy this module into a React, Angular, Vue, SvelteKit or plain HTML
 * page; only `attachEditor` is called by the page.
 *
 * Each function names the place that explains it: the spec section, and the section of the
 * integration guide (UX-090, phase 1b) that will carry the worked example.
 */
import type { PrincipalInfo, PrincipalQuery, UserInfo } from '@docedit/protocol';

/** The element's events this page listens to (05 §8.1), with the details it reads. */
interface ErrorDetail {
  code: string;
  message: string;
  fatal: boolean;
}
interface StatusDetail {
  connection: string;
  sync: string;
}

/**
 * The members of `<doc-editor>` this module uses (05 §8.1), written out so that the page needs the
 * element's published contract only, not its source. `flush` arrives with PRO-083 and is probed.
 */
export interface EditorLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
  getToken: ((ctx: { docId: string }) => Promise<string>) | null;
  resolveUsers: ((ids: readonly string[]) => Promise<ReadonlyArray<UserInfo | null>>) | null;
  searchPrincipals: ((query: PrincipalQuery) => Promise<PrincipalInfo[]>) | null;
  load(docId?: string): void;
  flush?: (options: { timeoutMs: number }) => Promise<void>;
}

/** Why the host's token endpoint refused, if it did (the page reacts to `de-auth-required` by it). */
export type TokenRefusal = 'session' | 'access' | 'unavailable' | null;

export interface GlueCallbacks {
  /** The host's session ended: show the host's sign-in. */
  onSignInNeeded(): void;
  /** The host no longer gives this person a role on the document. */
  onAccessLost(): void;
  /** `de-error` (05 §8.1): `message` is for people; `fatal` asks the host to act. */
  onError(detail: ErrorDetail): void;
  /** `de-status`: connection and save state, for the host's own indicator. */
  onStatus?(detail: StatusDetail): void;
  /** `de-share-request`: the person asked to share; the host opens its share dialog (UX-095). */
  onShareRequest?(): void;
}

export interface GlueOptions extends GlueCallbacks {
  /** The base of the host's API for the signed-in person, for example `/as/u-ada/api`. */
  api: string;
  /** The document; the host decided the role in it when it signed the token. */
  docId: string;
  fetch?: typeof fetch;
}

/**
 * `getToken` (05 §8.1, §3.1; 13 §11.1 item 2; guide: "Tokens: getToken and renewal"). Called by
 * the element at start and again when the service says the token is expiring, with `{ docId }`.
 * The token comes from the host's token endpoint in a response body, is handed to the element and
 * is kept by nobody else: never in a URL, a log line or browser storage (UX-092 criterion 3).
 */
export function tokenSource(
  api: string,
  onRefusal: (r: TokenRefusal) => void,
  f: typeof fetch = fetch,
): (ctx: { docId: string }) => Promise<string> {
  return async ({ docId }) => {
    let res: Response;
    try {
      // `cache` keeps the browser from storing the token response (UX-092 criterion 3).
      const init = {
        method: 'POST' as const,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ docId }),
        credentials: 'same-origin' as const,
        cache: 'no-store' as const,
      };
      res = await f(`${api}/token`, init);
    } catch {
      onRefusal('unavailable');
      throw new Error('the host could not be reached for a token');
    }
    if (res.status === 401) {
      onRefusal('session');
      throw new Error('the host session ended');
    }
    if (res.status === 403 || res.status === 404) {
      onRefusal('access');
      throw new Error('the host gives no access to this document');
    }
    if (!res.ok) {
      onRefusal('unavailable');
      throw new Error(`the host's token endpoint answered ${res.status}`);
    }
    onRefusal(null);
    const body = (await res.json()) as { token: string };
    return body.token;
  };
}

/**
 * `resolveUsers` (05 §8.1; PRO-080; guide: "The host's directory"): names for the identifiers the
 * editor shows (presence, comments, history). Identifiers only go to the host, never content.
 */
export function directoryResolver(
  api: string,
  f: typeof fetch = fetch,
): (ids: readonly string[]) => Promise<ReadonlyArray<UserInfo | null>> {
  return async (ids) => {
    const res = await f(`${api}/directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ resolve: ids }),
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`the host's directory answered ${res.status}`);
    return ((await res.json()) as { users: Array<UserInfo | null> }).users;
  };
}

/**
 * `searchPrincipals` (05 §8.1; 07 §7; guide: "The host's directory"): people and groups for the
 * grants dialog and mentions. The element sends a search string and the document identifier only.
 */
export function principalSearch(
  api: string,
  f: typeof fetch = fetch,
): (query: PrincipalQuery) => Promise<PrincipalInfo[]> {
  return async (query) => {
    const res = await f(`${api}/directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        search: {
          text: query.text,
          kinds: query.kinds ?? ['user', 'group'],
          limit: query.limit ?? 10,
        },
      }),
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`the host's directory answered ${res.status}`);
    return ((await res.json()) as { principals: PrincipalInfo[] }).principals;
  };
}

/** How long a second `de-auth-required` counts as a repeat of the first (a setting; ADR 0048). */
export const AUTH_RETRY_WINDOW_MS = 30_000;

/**
 * Connects the element to the host (13 §11.1 item 2; guide: "Page glue"): sets the token source and
 * the directory callbacks, and handles `de-auth-required`, `de-error`, `de-status` and
 * `de-share-request`. Returns the function that detaches everything. Set the properties before or
 * after `doc-id`: the element starts loading once both are present (PRO-075).
 */
export function attachEditor(el: EditorLike, opts: GlueOptions): () => void {
  const f = opts.fetch ?? fetch;
  let refusal: TokenRefusal = null;
  let lastRetry = Number.NEGATIVE_INFINITY;
  el.getToken = tokenSource(opts.api, (r) => (refusal = r), f);
  el.resolveUsers = directoryResolver(opts.api, f);
  el.searchPrincipals = principalSearch(opts.api, f);

  // `de-auth-required` (05 §8.1; guide: "When the token is refused"): the host decides. A host
  // session that ended means the host's sign-in; a role that was taken away means no more access;
  // otherwise the token was refused by the service (expired or revoked), so the page loads again,
  // which asks for a new token, once within the retry window.
  const onAuth = () => {
    if (refusal === 'session') return opts.onSignInNeeded();
    if (refusal === 'access') return opts.onAccessLost();
    const now = Date.now();
    if (now - lastRetry < AUTH_RETRY_WINDOW_MS) return opts.onAccessLost();
    lastRetry = now;
    el.load();
  };
  // `de-error` (05 §8.1; guide: "Errors"): `message` is shown; `fatal` means the editor waits for
  // the host, which offers to load the document again.
  const onError = (e: Event) => opts.onError((e as CustomEvent<ErrorDetail>).detail);
  const onStatus = (e: Event) => opts.onStatus?.((e as CustomEvent<StatusDetail>).detail);
  // `de-share-request` (05 §8.1; 13 §5; guide: "Sharing"): sharing belongs to the host.
  const onShare = () => opts.onShareRequest?.();
  el.addEventListener('de-auth-required', onAuth);
  el.addEventListener('de-error', onError);
  el.addEventListener('de-status', onStatus);
  el.addEventListener('de-share-request', onShare);
  if (el.getAttribute('doc-id') !== opts.docId) el.setAttribute('doc-id', opts.docId);
  return () => {
    el.removeEventListener('de-auth-required', onAuth);
    el.removeEventListener('de-error', onError);
    el.removeEventListener('de-status', onStatus);
    el.removeEventListener('de-share-request', onShare);
  };
}

export type FlushOutcome = 'flushed' | 'kept' | 'unsupported';

/**
 * Before the host navigates away (05 §8.1 `flush`; 13 §11.1 item 2; guide: "Leaving the page"):
 * waits until nothing the person typed is unconfirmed. When the wait times out, the work stays in
 * the editor's journal and reappears when the document is opened again; the host navigates anyway.
 */
export async function flushBeforeNavigation(
  el: EditorLike,
  timeoutMs: number,
): Promise<FlushOutcome> {
  if (typeof el.flush !== 'function') return 'unsupported';
  try {
    await el.flush({ timeoutMs });
    return 'flushed';
  } catch {
    return 'kept';
  }
}
