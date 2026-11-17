/**
 * The script-injection corpus of SEC-005 (10 §3.1), shared by the wire suites.
 */
/** Payloads of the classes the story names: script, handlers, URLs, SVG, MathML, CSS, prototype keys. */
export const PAYLOADS: readonly string[] = [
  '<script>window.__pwned = 1</script>',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '<svg onload=alert(1)>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  'expression(alert(1))',
  'url(javascript:alert(1))',
  '"><script>alert(1)</script>',
  '__proto__',
  'constructor.prototype.polluted',
  'DEP-CANARY-7f3a-<b>',
];
