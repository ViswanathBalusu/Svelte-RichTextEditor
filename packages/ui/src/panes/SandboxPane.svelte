<!--
  The panel of a sandboxed extension (UX-060; 13 §7.2). The pane holds one iframe with
  `sandbox="allow-scripts"` (extensions/sandbox-frame.ts); the extension's code runs in it with no
  handle on the shell. The frame is mounted when the pane opens and removed when it closes.

  Keyboard (UX-023): focus goes into the frame when the pane opens (the pane host focuses the first
  focusable thing of the pane, and the frame is one). A key press inside the frame never reaches
  the page, so the frame forwards Ctrl+F6, Alt+F6 (with Shift for backwards) and Escape, and the
  shell moves to the next landmark or closes the pane. The extension's own keys stay in its frame.
-->
<script lang="ts">
  import type { PaneProps } from '../shell/panes.ts';

  interface Props extends PaneProps {
    /** Mounts the frame in `container`, handing it the key sink; returns the function that removes it. */
    mount: (container: HTMLElement, onKey: NonNullable<PaneProps['frameKey']>) => () => void;
  }

  let props: Props = $props();

  function frame(node: HTMLElement) {
    return props.mount(node, (key) => props.frameKey?.(key));
  }
</script>

<div class="de-sandbox-pane" data-sandbox-pane {@attach frame}></div>
