<!--
  The horizontal ruler (UX-102; 13 §2; 02 §3 part `ruler`, §7, §10): the left, right and
  first-line indents and the tab stops of the paragraph at the caret. A drag or a key on a marker
  runs `setParagraphFormat`, the command the paragraph dialog runs, so the change is the same and
  goes through the same guards. Every marker can be reached and moved with the keyboard (arrow
  keys, Page Up and Down, Home and End; Delete removes a tab stop), and the Paragraph button opens
  the dialog (FE-104).

  The web view shows no pages (02 §7): the ruler measures from the left edge of the text and says
  what the PDF's margins are in a line of text beside it. Styled through the `ruler` part and the
  `--de-` properties only.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import '../i18n/late/dialogs.ts';
  import { useShell } from '../context.ts';
  import type { TabStopView } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';
  import {
    TWIPS_PER_CM,
    addTab,
    centimetreMarks,
    centimetres,
    indentPatch,
    indentsOf,
    keyPlace,
    markerAt,
    markerRange,
    moveMarker,
    moveTab,
    pxPerTwip,
    removeTab,
    snap,
    tabsPatch,
    type MarkerKind,
  } from '../shell/ruler.ts';

  interface Props {
    /** The element that holds the text; the ruler lines up with its left edge. */
    body: HTMLElement | null;
    zoom: number;
    /** Opens the paragraph dialog. */
    onDialog: () => void;
    /** Told after each change the ruler asked for: whether the core took it. */
    onChanged: (done: boolean) => void;
  }

  let { body, zoom, onDialog, onChanged }: Props = $props();

  const shell = useShell()!;
  const core = shell.core;
  const tr = $derived(shell.strings.current);
  const view = live(core.paragraphFormat!);
  const format = $derived(view.current);

  let root = $state<HTMLElement | null>(null);
  let track = $state<HTMLElement | null>(null);
  // Where the text starts on the ruler, and how wide it is, in CSS pixels.
  let origin = $state(0);
  let width = $state(0);

  const ppt = $derived(pxPerTwip(zoom));
  const column = $derived(width > 0 ? width / ppt : 0);

  function measure(): void {
    if (!root || !body) return;
    const r = root.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    origin = Math.max(0, b.left - r.left);
    width = b.width;
  }

  $effect(() => {
    void zoom;
    if (!root || !body) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(body);
    return () => observer.disconnect();
  });

  type Drag =
    | { kind: MarkerKind; at: number }
    | { kind: 'tab'; index: number; at: number };
  let drag = $state<Drag | null>(null);

  const indents = $derived(format ? indentsOf(format) : { left: 0, right: 0, firstLine: 0 });
  const shown = $derived(
    drag && drag.kind !== 'tab' ? moveMarker(drag.kind, drag.at, indents, column) : indents,
  );
  const tabs = $derived(format?.tabs ?? []);
  const editable = $derived(!!format && format.editable);
  const marks = $derived(centimetreMarks(column));
  const margins = $derived(
    format?.page
      ? tr.t('ruler.margins', {
          left: centimetres(format.page.marginLeft),
          right: centimetres(format.page.marginRight),
        })
      : '',
  );

  const MARKER_NAMES: Record<MarkerKind, StringKey> = {
    left: 'ruler.marker.left',
    firstLine: 'ruler.marker.firstLine',
    right: 'ruler.marker.right',
  };
  const ALIGN_NAMES: Record<TabStopView['align'], StringKey> = {
    left: 'dialog.paragraph.align.left',
    center: 'dialog.paragraph.align.center',
    right: 'dialog.paragraph.align.right',
    decimal: 'dialog.paragraph.align.decimal',
  };
  const MARKERS: readonly MarkerKind[] = ['right', 'firstLine', 'left'];

  const px = (twips: number): number => twips * ppt;
  const length = (pixels: number): string => `${pixels}px`;
  const placeOf = (event: PointerEvent): number =>
    track ? (event.clientX - track.getBoundingClientRect().left) / ppt : 0;

  function run(patch: Record<string, unknown> | null): void {
    if (!patch) return;
    onChanged(core.runNamed?.('setParagraphFormat', patch) ?? false);
  }

  function nameOf(kind: MarkerKind): string {
    return tr.t(MARKER_NAMES[kind]);
  }

  function valueText(name: string, twips: number): string {
    return tr.t('ruler.value', { name, value: centimetres(twips) });
  }

  function startDrag(event: PointerEvent, next: Drag): void {
    if (!editable || event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    (event.currentTarget as HTMLElement).focus();
    drag = next;
  }

  function moveDrag(event: PointerEvent): void {
    if (!drag) return;
    drag = { ...drag, at: snap(placeOf(event)) };
  }

  function endDrag(event: PointerEvent): void {
    const done = drag;
    drag = null;
    if (!done || !format) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    if (done.kind === 'tab') {
      const to = Math.min(Math.max(0, Math.round(done.at)), Math.round(column));
      if (tabs[done.index]?.position !== to) run(tabsPatch(moveTab(tabs, done.index, to)));
    } else {
      run(indentPatch(indents, moveMarker(done.kind, done.at, indents, column), format));
    }
  }

  function markerKey(event: KeyboardEvent, kind: MarkerKind): void {
    if (!editable || !format || event.altKey || event.ctrlKey || event.metaKey) return;
    const at = markerAt(kind, indents, column);
    const next = keyPlace(event.key, at, markerRange(kind, indents, column));
    if (next === null) return;
    event.preventDefault();
    if (next !== at)
      run(indentPatch(indents, moveMarker(kind, next, indents, column), format));
  }

  async function focusTab(position: number): Promise<void> {
    await tick();
    root?.querySelector<HTMLElement>(`[data-tab="${position}"]`)?.focus();
  }

  function tabKey(event: KeyboardEvent, index: number): void {
    const stop = tabs[index];
    if (!editable || !stop || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      run(tabsPatch(removeTab(tabs, index)));
      return;
    }
    const next = keyPlace(event.key, stop.position, { min: 0, max: Math.round(column) });
    if (next === null) return;
    event.preventDefault();
    if (next === stop.position) return;
    run(tabsPatch(moveTab(tabs, index, next)));
    void focusTab(next);
  }

  function addAt(event: PointerEvent): void {
    // Only a press on the bare ruler adds a stop; a marker or a stop has its own handlers.
    if (!editable || !format || format.tabs === null || event.button !== 0) return;
    if (event.target !== track && !(event.target as HTMLElement).dataset['tick']) return;
    const at = Math.min(Math.max(0, snap(placeOf(event))), Math.round(column));
    event.preventDefault();
    run(tabsPatch(addTab(tabs, at)));
    void focusTab(at);
  }

  const tabLabel = (align: TabStopView['align']): string =>
    tr.t('ruler.tab', { align: tr.t(ALIGN_NAMES[align]) });
</script>

<div
  bind:this={root}
  class="de-ruler"
  part="ruler"
  role="group"
  dir="ltr"
  aria-label={tr.t('ruler.label')}
>
  <!-- The bare ruler takes a press to add a tab stop; its keyboard form is the dialog. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={track}
    class="de-ruler-track"
    data-editable={editable ? 'true' : 'false'}
    style:inset-inline-start={length(origin)}
    style:inline-size={length(width)}
    onpointerdown={addAt}
  >
    {#each marks as cm (cm)}
      <span class="de-ruler-tick" data-tick="1" style:inset-inline-start={length(px(cm * TWIPS_PER_CM))}
        >{cm}</span
      >
    {/each}
    {#if format}
      {#each tabs as stop, index (index)}
        {@const at = drag && drag.kind === 'tab' && drag.index === index ? drag.at : stop.position}
        <span
          class="de-ruler-marker de-ruler-tabstop"
          role="slider"
          tabindex="0"
          data-tab={stop.position}
          data-align={stop.align}
          aria-orientation="horizontal"
          aria-label={tabLabel(stop.align)}
          aria-valuemin={0}
          aria-valuemax={centimetres(column)}
          aria-valuenow={centimetres(at)}
          aria-valuetext={valueText(tabLabel(stop.align), at)}
          aria-disabled={editable ? undefined : 'true'}
          style:inset-inline-start={length(px(at))}
          onpointerdown={(e) => startDrag(e, { kind: 'tab', index, at: stop.position })}
          onpointermove={moveDrag}
          onpointerup={endDrag}
          onpointercancel={() => (drag = null)}
          onkeydown={(e) => tabKey(e, index)}
        ></span>
      {/each}
      {#each MARKERS as kind (kind)}
        {@const at = markerAt(kind, shown, column)}
        <span
          class="de-ruler-marker de-ruler-indent"
          role="slider"
          tabindex="0"
          data-marker={kind}
          aria-orientation="horizontal"
          aria-label={nameOf(kind)}
          aria-valuemin={centimetres(markerRange(kind, indents, column).min)}
          aria-valuemax={centimetres(markerRange(kind, indents, column).max)}
          aria-valuenow={centimetres(at)}
          aria-valuetext={valueText(nameOf(kind), at)}
          aria-disabled={editable ? undefined : 'true'}
          style:inset-inline-start={length(px(at))}
          onpointerdown={(e) => startDrag(e, { kind, at })}
          onpointermove={moveDrag}
          onpointerup={endDrag}
          onpointercancel={() => (drag = null)}
          onkeydown={(e) => markerKey(e, kind)}
        ></span>
      {/each}
    {/if}
  </div>
  <div class="de-ruler-side">
    <button type="button" class="de-button" disabled={!editable} onclick={onDialog}
      >{tr.t('ruler.dialog')}</button
    >
  </div>
  <p class="de-ruler-note de-hint">{margins}</p>
</div>
