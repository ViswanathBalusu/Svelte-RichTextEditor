/** Types for `linebreak` 1.1.0 (UAX #14, MIT), which ships none. */
declare module 'linebreak' {
  export interface Break {
    /** A line may end before this UTF-16 offset. */
    readonly position: number;
    /** A mandatory break (after a line or paragraph separator). */
    readonly required: boolean;
  }
  export default class LineBreaker {
    constructor(text: string);
    nextBreak(): Break | null;
  }
}
