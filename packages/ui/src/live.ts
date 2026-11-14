/**
 * Reads a core view inside Svelte's reactivity without copying the core's state into it (02 §4):
 * `createSubscriber` ties the subscription to the effects that read `current`.
 */
import { createSubscriber } from 'svelte/reactivity';
import type { ReadView } from './core-api.ts';

export function live<T>(view: ReadView<T>): { readonly current: T } {
  const track = createSubscriber((update) => view.subscribe(update));
  return {
    get current() {
      track();
      return view.get();
    },
  };
}
