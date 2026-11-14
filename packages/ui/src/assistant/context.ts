/**
 * What the assistant may see (UX-047; 13 §6.2; ADR 0019 for the read restrictions).
 *
 * - `assembleContext` builds the request's context from three parts only: the selection, the
 *   surrounding blocks and the outline. Anything the host attaches through the port is added after
 *   them, unchanged, and marked as supplied by the host. No other field of the editor is read.
 * - A block or an outline entry whose scope the requester cannot view contributes nothing: its text
 *   is dropped and only a count of the dropped items is kept, so the port can say that something was
 *   left out without seeing it. The `viewable` check is the requester's projection, which the core
 *   supplies (the core also applies the same rule on the server).
 * - The function is pure. It creates no request and calls no port, so the caller decides what is
 *   sent (UX-045 is not built).
 */

/** A block of document text the assistant may be given. */
export interface ContextBlock {
  readonly id: string;
  /** The scope (for example a section or region) the block belongs to; `viewable` is asked about it. */
  readonly scope: string;
  readonly text: string;
}

/** An outline entry: a heading's text and its scope. */
export interface OutlineEntry {
  readonly id: string;
  readonly scope: string;
  readonly text: string;
  readonly level: number;
}

/** Something the host attaches through the assistant port (UX-048 keeps it as data). */
export interface HostAttachment {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

export interface ContextInput {
  readonly selection: readonly ContextBlock[];
  readonly surrounding: readonly ContextBlock[];
  readonly outline: readonly OutlineEntry[];
  readonly attachments: readonly HostAttachment[];
  /** True when the requester holds `view` on the scope (the requester's projection). */
  readonly viewable: (scope: string) => boolean;
}

export interface ContextBlockOut {
  readonly id: string;
  readonly text: string;
}

export interface OutlineOut {
  readonly id: string;
  readonly level: number;
  readonly text: string;
}

export interface AttachmentOut {
  readonly source: 'host';
  readonly id: string;
  readonly label: string;
  /** Passed through exactly as the host gave it. */
  readonly text: string;
}

/** The request context. Its keys are the three named parts and the host's attachments only. */
export interface AssistantContext {
  readonly selection: readonly ContextBlockOut[];
  readonly surrounding: readonly ContextBlockOut[];
  readonly outline: readonly OutlineOut[];
  readonly attachments: readonly AttachmentOut[];
  /** How many blocks or outline entries were left out because the requester cannot view them. */
  readonly omitted: number;
}

function keepBlocks(
  blocks: readonly ContextBlock[],
  viewable: (scope: string) => boolean,
): { kept: ContextBlockOut[]; omitted: number } {
  const kept: ContextBlockOut[] = [];
  let omitted = 0;
  for (const b of blocks) {
    if (viewable(b.scope)) kept.push({ id: b.id, text: b.text });
    else omitted++;
  }
  return { kept, omitted };
}

export function assembleContext(input: ContextInput): AssistantContext {
  const selection = keepBlocks(input.selection, input.viewable);
  const surrounding = keepBlocks(input.surrounding, input.viewable);
  const outline: OutlineOut[] = [];
  let outlineOmitted = 0;
  for (const o of input.outline) {
    if (input.viewable(o.scope)) outline.push({ id: o.id, level: o.level, text: o.text });
    else outlineOmitted++;
  }
  return {
    selection: selection.kept,
    surrounding: surrounding.kept,
    outline,
    attachments: input.attachments.map((a) => ({
      source: 'host' as const,
      id: a.id,
      label: a.label,
      text: a.text,
    })),
    omitted: selection.omitted + surrounding.omitted + outlineOmitted,
  };
}
