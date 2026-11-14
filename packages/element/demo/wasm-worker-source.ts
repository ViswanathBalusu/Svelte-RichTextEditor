/**
 * The worker used by the WebAssembly checks of spike S2 (ADR 0016): it compiles and instantiates a
 * 41-byte module that exports `add(a, b)`, records any `securitypolicyviolation` event raised in
 * the worker, and posts the result. The same source is served as a same-origin worker script
 * (`/wasm/worker.js`, with the policy the test asks for) and turned into a `blob:` worker by the page.
 */

/** (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)) */
export const TINY_WASM = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
  0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
  0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
];

export const WORKER_SOURCE = `
const bytes = new Uint8Array(${JSON.stringify(TINY_WASM)});
const violations = [];
self.addEventListener('securitypolicyviolation', (e) => {
  violations.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, sample: e.sample });
});
(async () => {
  const out = { compiled: false, instantiated: false, sum: null, error: null, violations };
  try {
    const module = await WebAssembly.compile(bytes);
    out.compiled = true;
    const instance = await WebAssembly.instantiate(module);
    out.instantiated = true;
    out.sum = instance.exports.add(2, 3);
  } catch (e) {
    out.error = (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e));
  }
  setTimeout(() => self.postMessage(out), 100);
})();
`;
