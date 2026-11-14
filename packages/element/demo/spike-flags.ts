/**
 * First script on every demo page (spike S1, S2): turns the spike instrumentation on and records
 * content security policy violations and errors from the start, so a test can read them.
 * Violations raised inside the shadow root reach the document: the event is composed.
 */

export interface RecordedViolation {
  directive: string;
  blocked: string;
  sample: string;
  source: string;
  line: number;
  disposition: string;
  target: string;
}

const violations: RecordedViolation[] = [];
const errors: string[] = [];

function describe(target: EventTarget | null): string {
  if (target instanceof Element) {
    const root = target.getRootNode();
    return `${target.localName}${root instanceof ShadowRoot ? ' (shadow)' : ''}`;
  }
  return target === document ? 'document' : String(target);
}

document.addEventListener(
  'securitypolicyviolation',
  (e) => {
    violations.push({
      directive: e.effectiveDirective || e.violatedDirective,
      blocked: e.blockedURI,
      sample: e.sample,
      source: e.sourceFile,
      line: e.lineNumber,
      disposition: e.disposition,
      target: describe(e.target),
    });
  },
  true,
);
window.addEventListener('error', (e) => errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${String(e.reason)}`));

Object.assign(globalThis, { __DOCEDIT_SPIKE__: { debug: true }, __spike: { violations, errors } });
