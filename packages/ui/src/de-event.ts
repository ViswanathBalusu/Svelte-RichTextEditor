/**
 * The one helper through which the shell dispatches a `de-` event (02 §3; 05 §8.1; FE-022
 * criterion 3). Every outgoing event is a composed, bubbling CustomEvent, so it crosses the shadow
 * boundary; a detail carries identifiers, counts and command names, never document content.
 * `test/de-event.test.ts` fails any other `dispatchEvent` in this package's source.
 */
export function dispatchDocEvent(
  target: EventTarget,
  name: `de-${string}`,
  detail: unknown,
): boolean {
  return target.dispatchEvent(
    new CustomEvent(name, { bubbles: true, composed: true, cancelable: false, detail }),
  );
}
