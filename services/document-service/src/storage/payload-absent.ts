/**
 * A commit whose payload is in no store (HIS-032 criterion 4; 08 §11, §13). A payload leaves the log
 * table in three ways. A move to a cold segment (HIS-029) keeps it: the log store reads it from the
 * segment, and this error is not raised. Thinning (HIS-032) and a tombstone (HIS-040) remove it,
 * from the table or from its segment, and keep the metadata and the hashes. For those the steps are
 * gone, so a rebuild that needs them answers that the detail is no longer available, and does not
 * fail as an internal error. The commit row itself stays in the log.
 *
 * A store that reads no cold segments (no object store was given to it) raises this error for a
 * moved payload too, since it cannot tell the two apart.
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
