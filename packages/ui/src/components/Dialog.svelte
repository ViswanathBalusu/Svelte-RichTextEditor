<!--
  A modal dialog of the shell (UX-068 criterion 7; 02 §3 overlays): the native `dialog` element
  shown with `showModal()`, so the rest of the page is inert and the dialog is in the top layer.
  Focus moves into it when it opens (the element marked `data-autofocus`, else the first control)
  and back to where it was when it closes; Escape closes it; it exposes the `dialog` part.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick, untrack } from 'svelte';
  import { useShell } from '../context.ts';

  interface Props {
    title: string;
    /** Called when the dialog asks to close (Escape, the close button). */
    onClose: () => void;
    children: Snippet;
    /** Extra identifier for tests and styling. */
    name: string;
  }

  let { title, onClose, children, name }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const titleId = `${shell.idPrefix}-dialog-${untrack(() => name)}-title`;

  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function open(node: HTMLDialogElement) {
    const root = node.getRootNode() as ShadowRoot | Document;
    const before = root.activeElement as HTMLElement | null;
    if (typeof node.showModal === 'function') node.showModal();
    else node.setAttribute('open', '');
    void tick().then(() => {
      const target =
        node.querySelector<HTMLElement>('[data-autofocus]') ??
        node.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    });
    return () => {
      if (node.open) node.close();
      // Back where it was, if that is still in the page; else the editing surface.
      if (before?.isConnected && typeof before.focus === 'function') {
        before.focus();
        // The editing surface holds no browser selection while a modal dialog is open, so a bare
        // focus() puts the caret at its start, and the view reads that as the person's move. The
        // core puts its own selection back.
        if (before.classList.contains('de-editing-surface')) shell.core.focus();
      } else shell.core.focus();
    };
  }

  function onCancel(event: Event): void {
    event.preventDefault();
    onClose();
  }
</script>

<dialog
  {@attach open}
  part="dialog"
  class="de-dialog"
  data-dialog={name}
  aria-labelledby={titleId}
  lang={tr.locale}
  dir={tr.dir}
  oncancel={onCancel}
>
  <div class="de-dialog-head">
    <h2 class="de-dialog-title" id={titleId}>{title}</h2>
    <button type="button" class="de-dialog-close" onclick={() => onClose()}
      >{tr.t('dialog.close')}</button
    >
  </div>
  <div class="de-dialog-body">
    {@render children()}
  </div>
</dialog>
