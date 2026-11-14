/**
 * Opens a channel only with the engine negotiated for it (05 §5.1 and §5.2; SYN-046 criterion 4).
 *
 * A channel's engine must be registered with the server, must be in the list the session
 * negotiated through `hello.engines` (when the caller gives one), and must be the engine the room
 * serves (`ENGINE`, `pm-steps/1`). Otherwise the room is not opened and the caller answers
 * `unsupported_engine`. `negotiatedEngine` is the only place that decides: `openNegotiatedChannel`
 * calls it before `Room.open`, and the service's data plane calls it in `#openChannel` with the
 * engines it negotiated from `hello.engines`, before it acquires the room.
 */
import type { EngineRegistry } from './engine.ts';
import type { Room } from './room.ts';
import { ENGINE, type Effects, type Resume, type RoomConnection } from './types.ts';

export interface ChannelEngineRequest {
  channel: string;
  conn: RoomConnection;
  resume?: Resume;
  /** `ch.open.engine` as the client sent it; any JSON value. */
  engine: unknown;
  /** The engines both sides share, from `hello.engines`. Omit to let the registry decide alone. */
  negotiated?: readonly string[];
}

export type ChannelEngineResult =
  | { ok: true; engine: string; fx: Effects }
  | { ok: false; code: 'unsupported_engine'; reason: string };

export type EngineDecision =
  { ok: true; engine: string } | { ok: false; code: 'unsupported_engine'; reason: string };

/**
 * The decision alone, for a caller that must refuse before it acquires a room (the service's data
 * plane, `#openChannel`): the engine of `ch.open.engine` must be registered, in the session's
 * negotiated list when one is given, and served by the room.
 */
export function negotiatedEngine(
  registry: EngineRegistry,
  engine: unknown,
  negotiated?: readonly string[],
): EngineDecision {
  const found = registry.forChannel(engine, negotiated);
  if (!found.ok) return found;
  // The room implements one engine. A registered engine it does not serve is refused as well,
  // so a channel never runs under an engine other than the one negotiated for it.
  if (found.engine.id !== ENGINE)
    return {
      ok: false,
      code: 'unsupported_engine',
      reason: `engine ${JSON.stringify(found.engine.id)} is not served by this room (${ENGINE})`,
    };
  return { ok: true, engine: found.engine.id };
}

export function openNegotiatedChannel(
  room: Pick<Room, 'open'>,
  registry: EngineRegistry,
  req: ChannelEngineRequest,
): ChannelEngineResult {
  const decided = negotiatedEngine(registry, req.engine, req.negotiated);
  if (!decided.ok) return decided;
  const fx = room.open(req.channel, req.conn, req.resume);
  return { ok: true, engine: decided.engine, fx };
}
