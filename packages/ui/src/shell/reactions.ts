/**
 * Reactions to a comment as the thread view shows them (UX-033; 13 §5; ADR 0424): the six reactions
 * a comment takes, how many people hold each, and whether the user is one of them. No DOM here.
 */
import type { ReactionName, ReactionView } from '../core-api.ts';

/** The reactions, in the order the service lists them and the buttons are laid out. */
export const REACTIONS: readonly ReactionName[] = [
  'thumbsUp',
  'heart',
  'laugh',
  'celebrate',
  'eyes',
  'done',
];

/** The picture on each button. The name of the reaction is its accessible name, never the picture. */
export const REACTION_SYMBOLS: Readonly<Record<ReactionName, string>> = {
  thumbsUp: '\u{1F44D}',
  heart: '\u2764\uFE0F',
  laugh: '\u{1F604}',
  celebrate: '\u{1F389}',
  eyes: '\u{1F440}',
  done: '\u2705',
};

export interface ReactionState {
  readonly reaction: ReactionName;
  /** The people who hold it, as principals, in the order they reacted. */
  readonly users: readonly string[];
  readonly count: number;
  /** Whether `self` is one of them: the button is pressed. */
  readonly mine: boolean;
}

/** One state for each reaction, held or not, so the buttons keep their places. */
export function reactionStates(
  reactions: readonly ReactionView[] | undefined,
  self: string,
): ReactionState[] {
  return REACTIONS.map((reaction) => {
    const users = reactions?.find((r) => r.reaction === reaction)?.users ?? [];
    return { reaction, users, count: users.length, mine: self !== '' && users.includes(self) };
  });
}

/** The people behind a reaction, named through `name`; null when nobody holds it. */
export function reactionPeople(
  state: ReactionState,
  name: (principal: string) => string,
): string | null {
  return state.count === 0 ? null : state.users.map(name).join(', ');
}
