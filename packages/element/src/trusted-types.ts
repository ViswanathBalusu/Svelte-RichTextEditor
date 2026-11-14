/**
 * The Trusted Types policies the component itself creates (02 §3; FE-016, FE-017). Each is created
 * lazily, on the first use of the feature that needs it, so a host that does not use the feature
 * need not allow its name. The names are what the integration guide publishes.
 */

interface TrustedTypePolicyLike {
  createHTML?(input: string): unknown;
  createScriptURL?(input: string): unknown;
}

interface TrustedTypesLike {
  createPolicy(
    name: string,
    rules: { createHTML?: (s: string) => string; createScriptURL?: (s: string) => string },
  ): TrustedTypePolicyLike;
}

/** Names published for hosts that restrict `trusted-types` (see the spike S2 report). */
export const POLICY_NAMES = {
  /** Worker scripts: the PDF viewer's worker, and later the layout and measurement workers. */
  worker: 'docedit-worker',
  /** Markup produced by the math editor (MathLive's `createHTML` hook). */
  mathEditor: 'docedit-math',
  /**
   * Clipboard HTML read into an inert document (FE-054). The engine's paste view creates this policy
   * (`PASTE_POLICY_NAME` in packages/engine/src/view/paste-policy.ts, not exported); the name is listed
   * here so that the published list is complete. test/published-policies.test.ts checks the two agree.
   */
  paste: 'docedit-paste',
} as const;

function trustedTypes(): TrustedTypesLike | null {
  return (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes ?? null;
}

let workerPolicy: TrustedTypePolicyLike | null | undefined;

/**
 * A worker script URL the page may load: same-origin, or a `blob:` URL this page created. Returns
 * the plain string where Trusted Types do not exist.
 */
export function workerScriptURL(url: string): string {
  const tt = trustedTypes();
  if (!tt) return url;
  workerPolicy ??= tt.createPolicy(POLICY_NAMES.worker, {
    createScriptURL: (input) => {
      const parsed = new URL(input, document.baseURI);
      if (parsed.protocol !== 'blob:' && parsed.origin !== location.origin)
        throw new TypeError(
          `${POLICY_NAMES.worker}: refusing a cross-origin worker ${parsed.href}`,
        );
      return parsed.href;
    },
  });
  return workerPolicy.createScriptURL!(url) as string;
}

let mathPolicy: TrustedTypePolicyLike | null | undefined;

/**
 * Markup from the math editor. MathLive builds it from LaTeX and escapes text itself; this policy
 * passes it through unchanged, so its safety rests on MathLive's escaping (recorded in the S2 report).
 */
export function mathEditorHTML(html: string): string {
  const tt = trustedTypes();
  if (!tt) return html;
  mathPolicy ??= tt.createPolicy(POLICY_NAMES.mathEditor, { createHTML: (input) => input });
  return mathPolicy.createHTML!(html) as string;
}
