// Imports the element's entry in a Node.js process that has no DOM, and reports what happened
// (FE-001): whether it threw, which browser globals it checked for (`typeof X`, `'X' in
// globalThis`) and which it read. Run by test/register.test.ts as `node <this file>`.
const BROWSER_GLOBALS = [
  'window',
  'document',
  'navigator',
  'location',
  'self',
  'customElements',
  'CustomElementRegistry',
  'HTMLElement',
  'Element',
  'Node',
  'ShadowRoot',
  'CSSStyleSheet',
  'DOMException',
  'requestAnimationFrame',
  'trustedTypes',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'getComputedStyle',
  'matchMedia',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'WebSocket',
  'Worker',
  'FontFace',
];

const watched = new Set(BROWSER_GLOBALS);
const checked: string[] = [];
const read: string[] = [];
// Every lookup of a name that is not an own property of the global object reaches its prototype:
// a proxy there sees existence checks (`has`) and reads (`get`).
const proto = Object.getPrototypeOf(globalThis) as object;
Object.setPrototypeOf(
  globalThis,
  new Proxy(proto, {
    has(target, key) {
      if (typeof key === 'string' && watched.has(key)) checked.push(key);
      return Reflect.has(target, key);
    },
    get(target, key, receiver) {
      if (typeof key === 'string' && watched.has(key)) read.push(key);
      return Reflect.get(target, key, receiver);
    },
  }),
);
const before = new Set(Object.getOwnPropertyNames(globalThis));

let error: string | null = null;
let exports: string[] = [];
try {
  const mod = (await import('../../src/index.ts')) as Record<string, unknown>;
  exports = Object.keys(mod).sort();
} catch (e) {
  error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
const added = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));
console.log(
  JSON.stringify({
    error,
    exports,
    checked: [...new Set(checked)].sort(),
    read: [...new Set(read)].sort(),
    added,
  }),
);
