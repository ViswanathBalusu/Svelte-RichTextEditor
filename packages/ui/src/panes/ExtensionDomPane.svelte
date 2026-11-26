<!--
  The panel of a host extension of tier 1 (UX-052; 13 §7.2). The extension runs in the page with the
  host's trust, so it draws its own elements into the container: no frame, no component of the
  shell's framework. The container is inside the shell root, so the extension's elements read the
  public `--de-` properties like the shell's own panes (criterion 5). The extension is held to the
  same accessibility requirements as a built-in pane (13 §8): names, keyboard operation, contrast.

  `mount` runs when the pane opens and the function it returns runs when the pane closes. A throw
  from `mount` is reported by the shell and leaves the pane empty.
-->
<script lang="ts">
  import type { PaneProps } from '../shell/panes.ts';

  interface Props extends PaneProps {
    /** Draws the panel into `container`; may return the function that removes what it drew. */
    mount: (container: HTMLElement) => (() => void) | undefined;
    /** Receives a problem the extension's `mount` raised. */
    onError?: (error: unknown) => void;
  }

  let props: Props = $props();

  function draw(node: HTMLElement) {
    try {
      const done = props.mount(node);
      return typeof done === 'function' ? done : undefined;
    } catch (error) {
      props.onError?.(error);
      return undefined;
    }
  }
</script>

<div class="de-extension-pane" data-extension-pane {@attach draw}></div>