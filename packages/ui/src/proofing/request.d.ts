/**
 * The request the editor sends to the proofing port (UX-041; 13 §6.1; 02 §15).
 *
 * - `proofingRequest` sends text only from scopes the requester can view. A block whose scope the
 *   requester cannot view contributes nothing, and only a count of the blocks left out is kept.
 * - The language of each block is its `lang` mark when it has one, else the document's default,
 *   else none. The port's findings are decorations, so the request says nothing about changing the
 *   document.
 * - `proofingControlShown` is the rule that no proofing control appears without a port.
 * - `isFindingCurrent` discards a finding computed for an earlier revision of the text. Discarding
 *   (not mapping) is the simpler of the two options criterion 3 allows; a mapping needs the core's
 *   position map, which this module does not see.
 *
 * Building block only: nothing in the editor calls these functions yet, because the proofing port
 * is not wired into the shell or the core. No criterion of UX-041 is claimed by this module alone.
 */
/** A block of text that may be proofed. */
export interface ProofingBlock {
  readonly id: string;
  /** The scope (for example a section or region) the block belongs to. */
  readonly scope: string;
  readonly text: string;
  /** The `lang` mark over the block's text, when it has one. */
  readonly lang?: string | null;
}
export interface ProofingItem {
  readonly id: string;
  /** The language tag sent with the text, or null when neither the mark nor the document gives one. */
  readonly lang: string | null;
  readonly text: string;
}
export interface ProofingRequest {
  readonly items: readonly ProofingItem[];
  /** How many blocks were left out because the requester cannot view their scope. */
  readonly omitted: number;
}
/**
 * Builds the proofing request. `viewable` is the requester's projection (the core supplies it), and
 * `documentLang` is the document's default language tag.
 */
export declare function proofingRequest(
  blocks: readonly ProofingBlock[],
  viewable: (scope: string) => boolean,
  documentLang: string | null | undefined,
): ProofingRequest;
/** The proofing control is offered only when a proofing port was given (UX-041 criterion 5). */
export declare function proofingControlShown(port: unknown): boolean;
/** A finding is current only for the text revision it was computed from (UX-041 criterion 3). */
export declare function isFindingCurrent(findingRevision: number, currentRevision: number): boolean;
