/**
 * Errors (01 §8; FND-003): RFC 9457 problem details over REST and typed error messages over the
 * socket, both carrying a stable `code`. The registry of codes, their HTTP statuses and their
 * client actions is the protocol's (PRO-038); this module only fixes the shape.
 */

export const ERROR_CODE_PATTERN = '^[a-z][a-z0-9_]{1,63}$';
const codeRe = new RegExp(ERROR_CODE_PATTERN);

export type ErrorCode = string & { readonly __brand: 'ErrorCode' };

export function errorCode(code: string): ErrorCode {
  if (!codeRe.test(code)) throw new RangeError(`not a valid error code: ${code}`);
  return code as ErrorCode;
}

/** RFC 9457 problem details with the stable `code` extension member. */
export interface ProblemDetails {
  /** A URI reference identifying the problem type. */
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  [extension: string]: unknown;
}

export interface ProblemInit {
  code: string;
  status: number;
  title: string;
  detail?: string;
  instance?: string;
  extensions?: Record<string, unknown>;
  /** Base URI for problem types; the type URI is `${typeBase}${code}`. */
  typeBase?: string;
}

export function problem(init: ProblemInit): ProblemDetails {
  const code = errorCode(init.code);
  if (!Number.isInteger(init.status) || init.status < 400 || init.status > 599) {
    throw new RangeError(`problem status must be 4xx or 5xx: ${init.status}`);
  }
  const out: ProblemDetails = {
    ...init.extensions,
    type: `${init.typeBase ?? 'urn:docedit:problem:'}${code}`,
    title: init.title,
    status: init.status,
    code,
  };
  if (init.detail !== undefined) out.detail = init.detail;
  if (init.instance !== undefined) out.instance = init.instance;
  return out;
}

/** The common shape of a typed error on the socket; message types and fields are PRO's. */
export interface SocketError {
  code: ErrorCode;
  message?: string;
}

/** An exception carrying a stable code, for code paths that need to throw. */
export class CodedError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CodedError';
    this.code = errorCode(code);
    this.details = details;
  }
}
