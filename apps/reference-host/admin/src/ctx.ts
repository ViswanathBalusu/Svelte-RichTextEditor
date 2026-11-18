import type { AdminClient } from './api.ts';

/** What every section of the console gets: the client and the two ways to tell the person. */
export interface Ctx {
  client: AdminClient;
  /** A message for the status region (polite). */
  say(message: string): void;
  /** An error for the alert region. */
  fail(error: unknown): void;
}

/** Runs one action: its error goes to the alert region, never to the console of the browser. */
export async function attempt(ctx: Ctx, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (e) {
    ctx.fail(e);
  }
}
