# ADR 0376: Session events (PRO-072)

Status: proposed. Lane w5, 2026-11-17.

## Context

`dep.session.joined` and `dep.session.left` are in the webhook registry (05 §7) with no data beyond the head `seq`. Nothing raised them. `dep.commit.rejected` was already raised from the room host for `permission_denied` and `invalid_op` (PRM-053).

## Decisions

1. The room host raises `dep.session.joined` after `ch.opened` has been sent on a channel, and `dep.session.left` when the channel leaves the room: closed by the client, closed by the room or the gateway, or closed because the room stops, is halted or is fenced. Each channel raises one of each. A session that opens a document twice raises two pairs; the protocol opens one channel for a document in a session.
2. The data is `{ seq, session }`: the document head at that moment and the session identifier. It carries no content and no user. The user is a per-tenant surrogate in the data plane, and the control plane maps surrogates to the host's `sub` for the wire (G11); the host can match the session to its own token. Putting the `sub` in the event needs the user directory in the room host and is left open.
3. Stopping a node raises `left` for every channel it closes, and the clients' reconnection raises `joined` again. The events say what the room did, not whether the person stayed.
4. A refusal with a code other than `permission_denied` or `invalid_op` raises no `dep.commit.rejected` (already so in `rejectionAudit`); this is now tested. The throttle of `dep.commit.rejected` stays in the webhook dispatcher (`rejectedThrottle`; PRM-053 criterion 5). The window and the maximum are settings the spec gives no figure for (ADR 0146).

## Consequences

A busy document raises two events for every client that connects. Subscriptions list the types they want (PRO-072 criterion 6), so a host that does not list the two session types receives none; the sink does not throttle them.
