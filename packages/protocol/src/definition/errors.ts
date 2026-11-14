/**
 * The error registry of 05 §5.8 and the close codes of 05 §5.7, as data (PRO-038). The code
 * enumerations in the AsyncAPI and OpenAPI documents and in the generated types come from here.
 */

/** Where a code may appear: the socket (`error`), REST problems, `sync.reject`, `ch.closed`. */
export type Surface = 'socket' | 'rest' | 'sync' | 'channel-close';

export type Retry = 'no' | 'yes' | 'after-new-token' | 'after-catch-up' | 'after-retry-after';

export interface ErrorDef {
  code: string;
  surfaces: readonly Surface[];
  retryable: Retry;
  /** Client action, from the registry table and 04 §8. */
  clientAction: string;
  /** `sync.reject` action (04 §8), for codes that appear in `sync.reject`. */
  syncAction?: readonly ('rebase' | 'drop' | 'reload' | 'retry')[];
  /** Close code implied when the code is fatal (decision D25; inferred, not tabulated). */
  closeCode?: number;
  /**
   * The HTTP status of a REST problem with this code (decision D61). `precondition_failed` is 412
   * for a stale `If-Match` and 428 when it is missing.
   */
  httpStatus?: number;
  gaps?: readonly string[];
}

const ALL: readonly Surface[] = ['socket', 'rest', 'sync', 'channel-close'];

export const ERRORS: readonly ErrorDef[] = [
  {
    code: 'bad_message',
    surfaces: ['socket'],
    retryable: 'no',
    clientAction: 'Report a bug.',
    closeCode: 4400,
  },
  { code: 'unknown_type', surfaces: ['socket'], retryable: 'no', clientAction: 'Report a bug.' },
  {
    code: 'unauthenticated',
    surfaces: ['socket', 'rest'],
    retryable: 'after-new-token',
    clientAction: 'Call getToken; raise de-auth-required if it fails.',
    closeCode: 4401,
    httpStatus: 401,
  },
  {
    code: 'token_expired',
    surfaces: ['socket', 'rest'],
    retryable: 'after-new-token',
    clientAction: 'Call getToken; raise de-auth-required if it fails.',
    closeCode: 4401,
    httpStatus: 401,
  },
  {
    code: 'revoked',
    surfaces: ['socket', 'rest'],
    retryable: 'after-new-token',
    clientAction: 'Call getToken; raise de-auth-required if it fails.',
    closeCode: 4401,
    httpStatus: 401,
  },
  {
    code: 'forbidden',
    surfaces: ALL,
    retryable: 'no',
    clientAction: 'Show as no access.',
    closeCode: 4403,
    httpStatus: 403,
    gaps: ['G34'],
  },
  {
    code: 'unsupported_version',
    surfaces: ['socket'],
    retryable: 'no',
    clientAction: 'Tell the user the component must be updated.',
    closeCode: 4406,
  },
  {
    code: 'unsupported_engine',
    surfaces: ['socket'],
    retryable: 'no',
    clientAction: 'Tell the user the component must be updated.',
  },
  {
    code: 'unsupported_cdm',
    surfaces: ['socket'],
    retryable: 'no',
    clientAction: 'Tell the user the component must be updated.',
  },
  {
    code: 'unsupported_feature',
    surfaces: ['socket'],
    retryable: 'no',
    clientAction: 'Tell the user the component must be updated.',
  },
  {
    code: 'not_found',
    surfaces: ['socket', 'rest'],
    retryable: 'no',
    clientAction: 'None given.',
    httpStatus: 404,
  },
  {
    code: 'already_open',
    surfaces: ['socket', 'rest'],
    retryable: 'no',
    clientAction: 'None given.',
    httpStatus: 409,
    gaps: ['G51'],
  },
  {
    code: 'channel_limit',
    surfaces: ['socket', 'rest'],
    retryable: 'no',
    clientAction: 'None given.',
    httpStatus: 409,
    gaps: ['G51'],
  },
  {
    code: 'stale_base',
    surfaces: ['sync'],
    retryable: 'after-catch-up',
    clientAction:
      'Wait until the confirmed seq reaches head, then resubmit the rebased steps with a new id (04 §8); after a snapshot commit, resubmit what still applies to the new content (04 §3.2).',
    syncAction: ['rebase'],
  },
  {
    code: 'rebase_failed',
    surfaces: ['sync'],
    retryable: 'after-catch-up',
    clientAction:
      'Wait until the confirmed seq reaches head, then resubmit the rebased steps with a new id (04 §8).',
    syncAction: ['rebase'],
  },
  {
    code: 'permission_denied',
    surfaces: ['sync'],
    retryable: 'no',
    clientAction: 'Drop and explain; keep the content as recovered edits and refresh permissions.',
    syncAction: ['drop'],
  },
  {
    code: 'read_only',
    surfaces: ['sync'],
    retryable: 'no',
    clientAction:
      'Drop; switch the editor to read-only. Checked before permission_denied (04 §5 step 1).',
    syncAction: ['drop'],
  },
  {
    code: 'invalid_op',
    surfaces: ['sync'],
    retryable: 'no',
    clientAction: 'Drop, or reload when told to.',
    syncAction: ['drop', 'reload'],
    gaps: ['G38'],
  },
  {
    code: 'conflict',
    surfaces: ['sync', 'rest'],
    retryable: 'no',
    clientAction:
      'Discard the fill and show the current value (12). On REST: the request conflicts with the current state, for example an `externalId` already in use; read the resource and decide again.',
    syncAction: ['drop'],
    httpStatus: 409,
  },
  {
    code: 'field_invalid',
    surfaces: ['sync', 'rest'],
    retryable: 'no',
    clientAction: 'Discard the fill and show the validation message (12).',
    syncAction: ['drop'],
    httpStatus: 422,
  },
  {
    code: 'busy',
    surfaces: ['sync'],
    retryable: 'yes',
    clientAction: 'Resubmit after the pending answer.',
    syncAction: ['retry'],
  },
  {
    code: 'too_large',
    surfaces: ALL,
    retryable: 'no',
    clientAction: 'Split or report.',
    syncAction: ['drop'],
    closeCode: 4413,
    httpStatus: 413,
  },
  {
    code: 'rate_limited',
    surfaces: ALL,
    retryable: 'after-retry-after',
    clientAction:
      'Back off for retryAfterMs or Retry-After. Also a spent CPU budget in a room (04 §12; 06 §12).',
    syncAction: ['retry'],
    closeCode: 4429,
    httpStatus: 429,
  },
  {
    code: 'quota_exceeded',
    surfaces: ALL,
    retryable: 'after-retry-after',
    clientAction: 'Back off and tell the user.',
    httpStatus: 429,
    gaps: ['G34'],
  },
  { code: 'slow_consumer', surfaces: ['channel-close'], retryable: 'yes', clientAction: 'Resume.' },
  {
    code: 'precondition_failed',
    surfaces: ['rest'],
    retryable: 'no',
    clientAction:
      'Fix the request: read the resource for its current ETag and send it in If-Match. 412 for a stale If-Match, 428 for a missing one.',
    httpStatus: 412,
  },
  {
    code: 'validation_failed',
    surfaces: ['rest'],
    retryable: 'no',
    clientAction: 'Fix the request.',
    httpStatus: 400,
  },
  {
    code: 'pending_suggestions',
    surfaces: ['rest'],
    retryable: 'no',
    clientAction: 'Fix the request.',
    httpStatus: 409,
  },
  {
    code: 'workflow_active',
    surfaces: ['rest'],
    retryable: 'no',
    clientAction: 'Fix the request.',
    httpStatus: 409,
  },
  {
    code: 'idempotency_mismatch',
    surfaces: ['rest'],
    retryable: 'no',
    clientAction: 'Fix the request.',
    httpStatus: 422,
  },
  {
    code: 'unavailable',
    surfaces: ALL,
    retryable: 'yes',
    clientAction: 'Back off.',
    syncAction: ['retry'],
    closeCode: 4503,
    httpStatus: 503,
  },
  {
    code: 'internal',
    surfaces: ALL,
    retryable: 'yes',
    clientAction: 'Back off.',
    closeCode: 4500,
    httpStatus: 500,
    gaps: ['G34'],
  },
];

export interface CloseCodeDef {
  code: number;
  meaning: string;
}

/** 05 §5.7. */
export const CLOSE_CODES: readonly CloseCodeDef[] = [
  { code: 4400, meaning: 'Malformed message' },
  { code: 4401, meaning: 'Unauthenticated, token expired or revoked' },
  { code: 4403, meaning: 'Forbidden, including a disallowed origin' },
  {
    code: 4406,
    meaning: "No common protocol version. The preceding error lists the server's versions",
  },
  { code: 4408, meaning: 'hello not received in time' },
  { code: 4413, meaning: 'Message too large' },
  { code: 4429, meaning: 'Rate limited' },
  { code: 4500, meaning: 'Internal error' },
  { code: 4503, meaning: 'Unavailable or draining' },
];

export const ERROR_CODES: readonly string[] = ERRORS.map((e) => e.code);

export function codesFor(surface: Surface): string[] {
  return ERRORS.filter((e) => e.surfaces.includes(surface)).map((e) => e.code);
}

/** `ch.rejected` codes, listed in 05 §5.2. */
export const CHANNEL_REJECT_CODES: readonly string[] = [
  'not_found',
  'forbidden',
  'unsupported_engine',
  'unsupported_cdm',
  'unsupported_feature',
  'channel_limit',
  'already_open',
  'unavailable',
];

/** `ch.closed` codes named in 05 §5.2 (examples only, G31) and the channel-close surface. */
export const CHANNEL_CLOSE_CODES: readonly string[] = ['forbidden', 'unavailable', 'slow_consumer'];
