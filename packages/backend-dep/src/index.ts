/**
 * `@docedit/backend-dep`: the backend ports of 05 §8.3 over the Document Editing Protocol, for any
 * conforming server (PRO-093, PRO-094). Runs in browsers and in Node.js 22: the platform WebSocket,
 * `fetch` and timers, nothing else.
 *
 *   const backend = createDepBackend({ endpoint: 'https://docs.example.com', getToken });
 *   await backend.connect();
 */
export {
  DEFAULT_FEATURES,
  DepBackend,
  createDepBackend,
  type ConnectionPort,
  type ConnectionStatus,
  type DepBackendOptions,
  type Diagnostic,
} from './backend.ts';
export {
  Timers,
  platform,
  type FetchLike,
  type Platform,
  type RequestInitLike,
  type ResponseLike,
  type SocketCloseEvent,
  type SocketMessageEvent,
  type TimerHandle,
  type WebSocketConstructor,
  type WebSocketLike,
} from './platform.ts';
