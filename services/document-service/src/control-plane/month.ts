/** The month a Unix time in milliseconds counts in, as `YYYY-MM` in UTC. */
export function monthOf(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
