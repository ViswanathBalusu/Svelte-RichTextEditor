<!--
  The page thumbnails of the navigation pane (UX-021; 13 §2). A list box of one option for each
  page: only the options near what the list shows are in the DOM (shell/page-thumbnails.ts), each
  drawn by the view that has the pages (`PageThumbnails.paint`). Choosing an option moves the view
  to that page, and the page the view shows is the selected option.

  The drawing of a page is a picture: it is hidden from assistive technology and inert. The option
  is the page number under it, named "Page n of m" from the catalogue, in the locale in use. The
  keys are those of a list box: the arrows, Home, End, Page Up and Page Down move, Enter and Space
  choose.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { useShell } from '../context.ts';
  import type { PageThumbnails, PagesInfo } from '../core-api.ts';
  import { sourceTranslator } from '../i18n/strings.ts';
  import {
    THUMB_WIDTH,
    pageStep,
    revealScroll,
    thumbKey,
    thumbLayout,
    thumbWindow,
  } from '../shell/page-thumbnails.ts';

  interface Props {
    pages: PageThumbnails;
    /** The pages now: the pane reads the view and passes it on while there are pages. */
    info: PagesInfo;
    /** A prefix for the identifiers of the options. */
    id: string;
  }

  let { pages, info, id }: Props = $props();

  const shell = useShell();
  const fallback = sourceTranslator();
  const tr = $derived(shell?.strings.current ?? fallback);

  /** How long the pages must have stayed as they are before the thumbnails are drawn again. */
  const REDRAW_AFTER_MS = 250;

  let scroller: HTMLElement | undefined = $state();
  let scrollTop = $state(0);
  let viewport = $state(0);
  /** The option that has the list's one tab stop. */
  let active = $state(untrack(() => info.current));
  /** The layout the thumbnails were last drawn for; it follows `info.revision` after a pause. */
  let drawn = $state(untrack(() => info.revision));

  const layout = $derived.by(() => {
    // A new layout of the document may change the pages' sizes, not only their number.
    void info.revision;
    return thumbLayout(info.count, (index) => pages.size(index));
  });
  const win = $derived(thumbWindow(layout, scrollTop, viewport));
  /** The options in the DOM: the window, and the one with the tab stop wherever it is. */
  const items = $derived.by(() => {
    const out: number[] = [];
    if (win) for (let i = win.first; i <= win.last; i++) out.push(i);
    const at = Math.min(Math.max(0, active), info.count - 1);
    if (info.count > 0 && !out.includes(at)) {
      out.push(at);
      out.sort((a, b) => a - b);
    }
    return out;
  });
  const tabStop = $derived(Math.min(Math.max(0, active), Math.max(0, info.count - 1)));

  function measure(): void {
    if (!scroller) return;
    scrollTop = scroller.scrollTop;
    viewport = scroller.clientHeight;
  }

  function hasFocus(): boolean {
    const root = scroller?.getRootNode() as Document | ShadowRoot | undefined;
    return !!scroller && !!root?.activeElement && scroller.contains(root.activeElement);
  }

  /** Scrolls the list so that an option is inside it. */
  function reveal(index: number): void {
    if (!scroller) return;
    const next = revealScroll(layout, index, scroller.scrollTop, scroller.clientHeight);
    if (next !== scroller.scrollTop) scroller.scrollTop = next;
    measure();
  }

  // The list has a size once it is in the page.
  $effect(() => {
    if (scroller) measure();
  });

  // The list follows the view: when the view shows another page, that page's thumbnail is brought
  // into the list. It also takes the tab stop, unless the author is in the list: their place there
  // is not taken away.
  $effect(() => {
    const current = info.current;
    void info.count;
    untrack(() => {
      if (!hasFocus()) active = current;
      reveal(current);
    });
  });

  // Thumbnails are drawn again only after the pages have stayed as they are for a moment, so that
  // typing does not redraw them at every key.
  $effect(() => {
    const revision = info.revision;
    if (revision === untrack(() => drawn)) return;
    const timer = setTimeout(() => (drawn = revision), REDRAW_AFTER_MS);
    return () => clearTimeout(timer);
  });

  /** Draws a page into its thumbnail when it enters the list, and again after a new layout. */
  function paint(index: number) {
    return (node: HTMLElement): void => {
      void drawn;
      pages.paint(index, node, THUMB_WIDTH);
    };
  }

  function choose(index: number): void {
    active = index;
    pages.goTo(index);
  }

  async function focusOption(index: number): Promise<void> {
    active = index;
    reveal(index);
    await tick();
    scroller?.querySelector<HTMLElement>(`[data-page="${index}"]`)?.focus({ preventScroll: true });
  }

  /** A click on a thumbnail: the page is chosen, and its option has the focus, as after a key. */
  function pick(index: number): void {
    choose(index);
    void focusOption(index);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(tabStop);
      return;
    }
    const next = thumbKey(
      event.key,
      tabStop,
      info.count,
      pageStep(layout, tabStop, scroller?.clientHeight ?? 0),
    );
    if (next === null) return;
    event.preventDefault();
    void focusOption(next);
  }

  // Focus is the author's place in the list, however it got there.
  function onFocusIn(event: FocusEvent): void {
    const option = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-page]');
    const index = Number(option?.dataset['page']);
    if (option && Number.isInteger(index)) active = index;
  }
</script>

<div
  bind:this={scroller}
  class="de-thumbs"
  role="listbox"
  tabindex="-1"
  aria-label={tr.t('pages.label')}
  data-pages={info.count}
  onscroll={measure}
  onkeydown={onKeydown}
  onfocusin={onFocusIn}
>
  <div class="de-thumbs-space" role="presentation" style:block-size={`${layout.total}px`}>
    {#each items as index (index)}
      <!-- A thumbnail is a drawing and, under it, the option: the page number, which is the
           option's visible label and part of its name. The drawing is beside the option, not in
           it, so that the page's text is no part of what the option says. A click anywhere on the
           thumbnail chooses it; the keys are handled once, on the list, for the focused option. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="de-thumb"
        role="presentation"
        data-current={index === info.current ? '' : undefined}
        style:inset-block-start={`${layout.tops[index] ?? 0}px`}
        onclick={() => pick(index)}
      >
        <div
          class="de-thumb-page"
          aria-hidden="true"
          inert
          style:inline-size={`${THUMB_WIDTH}px`}
          style:block-size={`${layout.heights[index] ?? 0}px`}
          {@attach paint(index)}
        ></div>
        <div
          class="de-thumb-number"
          role="option"
          id={`${id}-page-${index}`}
          data-page={index}
          aria-label={tr.t('pages.thumbnail', { page: index + 1, pages: info.count })}
          aria-selected={index === info.current}
          aria-setsize={info.count}
          aria-posinset={index + 1}
          tabindex={index === tabStop ? 0 : -1}
        >
          {tr.number(index + 1)}
        </div>
      </div>
    {/each}
  </div>
</div>
