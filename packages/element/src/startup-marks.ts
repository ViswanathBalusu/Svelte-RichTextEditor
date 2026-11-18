/**
 * Start-up marks of the editing shell (FE-119 criterion 5). A measurement of the time to
 * interactive says where the shell's own initialisation ended and the body view began, so that a
 * change in the shell is not read as a change in the document.
 *
 * The marks use the User Timing API, so that a harness, a test or the browser's tools can read
 * them. They carry no document data. A missing or failing API is ignored.
 *
 * Order in one editor start:
 *   registry-start, registry-end   the command registry (13 §4)
 *   body-start, body-end           the core's body view being attached (`core.mountBody`)
 *   mounted                        the shell's `mount` and its first effects have run
 *
 * The shell's own initialisation is `registry` plus `chrome`: the time from the end of the
 * registry to the start of the body view, which covers the header, the toolbar and the other
 * components the shell renders before the body.
 */
export const STARTUP = {
  start: 'de:shell:start',
  registryEnd: 'de:shell:registry-end',
  bodyStart: 'de:body:start',
  bodyEnd: 'de:body:end',
  mounted: 'de:shell:mounted',
  /** Measures made from the marks. */
  registry: 'de:shell-registry',
  chrome: 'de:shell-chrome',
  body: 'de:body-view',
  total: 'de:shell-mount',
} as const;

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    // The timeline is optional.
  }
}

function measure(name: string, from: string, to: string): void {
  try {
    performance.measure(name, from, to);
  } catch {
    // A mark that was never set (the body view attached late, or not at all) gives no measure.
  }
}

/** Marks the start of a shell start-up. */
export function markShellStart(): void {
  mark(STARTUP.start);
}

/** Marks the end of the registry and measures it. */
export function markRegistryEnd(): void {
  mark(STARTUP.registryEnd);
  measure(STARTUP.registry, STARTUP.start, STARTUP.registryEnd);
}

/** Runs the body view's attachment between its two marks. */
export function timeBodyAttach<T>(attach: () => T): T {
  mark(STARTUP.bodyStart);
  measure(STARTUP.chrome, STARTUP.registryEnd, STARTUP.bodyStart);
  try {
    return attach();
  } finally {
    mark(STARTUP.bodyEnd);
    measure(STARTUP.body, STARTUP.bodyStart, STARTUP.bodyEnd);
  }
}

/** Marks the end of the shell's mount and measures the whole. */
export function markShellMounted(): void {
  mark(STARTUP.mounted);
  measure(STARTUP.total, STARTUP.start, STARTUP.mounted);
}
