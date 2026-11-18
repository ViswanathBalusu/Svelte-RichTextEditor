/**
 * The message the element shows in the editor area when a document cannot be opened (PRO-039
 * criteria 2 to 4; 05 §5.8; owner decision 45: a full message with one action, and an event to the
 * host). The event is the fatal `de-error` that the session raises first; this is what the person
 * at the page sees instead of a blank area.
 *
 * - `forbidden`: the document is shown as no access. Nothing is retried; the action asks for the
 *   document again, which the person chooses when access has been given.
 * - `unsupported_version`, `unsupported_engine`, `unsupported_cdm`, `unsupported_feature`: the
 *   person is told that the component must be updated. Nothing is retried; the action loads the page
 *   again.
 * - `rate_limited`, `quota_exceeded`: the person is told, with the wait the server asked for, and
 *   the action stays disabled until that wait has passed.
 * - any other fatal failure: a general message and the same action.
 *
 * Strings are in `strings.ts` (13 §8). The view is plain data; `mountFailure` is the only part that
 * touches the DOM, and it takes the document and the timers so that it is tested without a browser.
 */
import type { ErrorCode } from '@docedit/protocol';
import { EN, format, type FailureStrings } from './strings.ts';

/** What a failed load reports: the registry code and the wait the refusal asked for, if any. */
export interface FailureInfo {
  code: ErrorCode;
  retryAfterMs: number | null;
}

export type FailureKind = 'no-access' | 'update' | 'wait' | 'quota' | 'other';

/** What the one action does: ask for the document again, or load the page again. */
export type FailureActionId = 'retry' | 'reload-page';

export interface FailureView {
  code: ErrorCode;
  kind: FailureKind;
  title: string;
  message: string;
  action: {
    id: FailureActionId;
    label: string;
    /** The action is disabled for this long (the wait the server asked for), in milliseconds. */
    enabledAfterMs: number;
  };
}

const UPDATE_CODES: ReadonlySet<string> = new Set([
  'unsupported_version',
  'unsupported_engine',
  'unsupported_cdm',
  'unsupported_feature',
]);

export function failureKind(code: ErrorCode): FailureKind {
  if (code === 'forbidden') return 'no-access';
  if (UPDATE_CODES.has(code)) return 'update';
  if (code === 'rate_limited') return 'wait';
  if (code === 'quota_exceeded') return 'quota';
  return 'other';
}

/** The view of a failed load: the kind, the words and the action. */
export function failureView(
  code: ErrorCode,
  retryAfterMs: number | null,
  strings: FailureStrings = EN.failure,
): FailureView {
  const kind = failureKind(code);
  const seconds = retryAfterMs === null ? null : Math.max(1, Math.ceil(retryAfterMs / 1000));
  const retry = { id: 'retry' as const, label: strings.retry, enabledAfterMs: 0 };
  switch (kind) {
    case 'no-access':
      return {
        code,
        kind,
        title: strings.noAccessTitle,
        message: strings.noAccessMessage,
        action: retry,
      };
    case 'update':
      return {
        code,
        kind,
        title: strings.updateTitle,
        message: strings.updateMessage,
        action: { id: 'reload-page', label: strings.reloadPage, enabledAfterMs: 0 },
      };
    case 'wait':
      return {
        code,
        kind,
        title: strings.waitTitle,
        message:
          seconds === null ? strings.waitMessageUnknown : format(strings.waitMessage, { seconds }),
        action: { ...retry, enabledAfterMs: retryAfterMs ?? 0 },
      };
    case 'quota':
      return {
        code,
        kind,
        title: strings.quotaTitle,
        message:
          seconds === null
            ? strings.quotaMessageUnknown
            : format(strings.quotaMessage, { seconds }),
        action: { ...retry, enabledAfterMs: retryAfterMs ?? 0 },
      };
    default:
      return {
        code,
        kind,
        title: strings.otherTitle,
        message: strings.otherMessage,
        action: retry,
      };
  }
}

/** The members of the DOM that `mountFailure` uses, so that a test can stand in for them. */
export interface FailureDom {
  createElement(tag: string): FailureNode;
}

export interface FailureNode {
  className: string;
  textContent: string | null;
  disabled?: boolean;
  setAttribute(name: string, value: string): void;
  append(...children: FailureNode[]): void;
  addEventListener(type: 'click', listener: () => void): void;
  remove(): void;
}

export interface FailureTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FailureSurface {
  readonly element: FailureNode;
  /** Takes the message out of the root and cancels the wait. */
  remove(): void;
}

/**
 * Puts the message first in `root`. The area has `role="alert"`, so a screen reader says it once; the
 * action is a button that is disabled until the wait of a refused request has passed.
 */
export function mountFailure(
  root: { prepend(node: FailureNode): void },
  view: FailureView,
  onAction: (id: FailureActionId) => void,
  dom: FailureDom = document as unknown as FailureDom,
  timers: FailureTimers = globalThis as unknown as FailureTimers,
): FailureSurface {
  const area = dom.createElement('div');
  area.className = 'de-failure';
  area.setAttribute('role', 'alert');
  area.setAttribute('data-code', view.code);
  area.setAttribute('data-kind', view.kind);
  const title = dom.createElement('p');
  title.className = 'de-failure-title';
  title.textContent = view.title;
  const message = dom.createElement('p');
  message.className = 'de-failure-message';
  message.textContent = view.message;
  const button = dom.createElement('button');
  button.className = 'de-failure-action';
  button.setAttribute('type', 'button');
  button.setAttribute('data-action', view.action.id);
  button.textContent = view.action.label;
  let timer: unknown = null;
  if (view.action.enabledAfterMs > 0) {
    button.disabled = true;
    timer = timers.setTimeout(() => {
      timer = null;
      button.disabled = false;
    }, view.action.enabledAfterMs);
  }
  button.addEventListener('click', () => {
    if (button.disabled !== true) onAction(view.action.id);
  });
  area.append(title, message, button);
  root.prepend(area);
  return {
    element: area,
    remove() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      area.remove();
    },
  };
}
