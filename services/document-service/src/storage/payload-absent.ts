/**
 * A commit whose payload is not in the log table (HIS-032 criterion 4; 08 §11). The service removes
 * a payload from PostgreSQL in two ways: thinning, which keeps the metadata and the hashes, and the
 * move to a cold segment (HIS-029), which the service does not read yet. Either way the steps are
 * not available here, so a rebuild that needs them answers that the detail is no longer available,
 * and does not fail as an internal error. The commit row itself stays in the log.
 */
export class PayloadAbsentError extends Error {
  /** The sequence number of the commit whose payload is missing. */
  readonly seq: number;

  constructor(seq: number) {
    super(`the payload of commit ${seq} is not in the log table`);
    this.name = 'PayloadAbsentError';
    this.seq = seq;
  }
}
