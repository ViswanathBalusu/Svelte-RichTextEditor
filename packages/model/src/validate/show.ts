/**
 * A value as text for a message (CDM-015). A module of its own so that code that only words a
 * message does not take the grammar checker with it (FND-008).
 */

/** A value as text for a message; never throws, whatever a hostile caller passed (CDM-015). */
export function show(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}
