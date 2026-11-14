<!--
  The access-key tips (UX-012; 13 §4). While the access-key mode is on, each control that shows a
  key gets the key as a visible tip and as text its screen reader announces (aria-description on the
  control). The parent gives the controls and their keys; both go away when the mode ends.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import type { AccessKeyTip } from '../shell/access-key-mode.ts';

  interface Props {
    /** The toolbar controls that show a key, each with its key (one letter or digit). */
    tips: readonly AccessKeyTip[];
  }

  let { tips }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);

  // Placed where the control is when the mode starts; the toolbar does not move while it is on.
  const placed = $derived(
    tips.map((tip) => {
      const rect = tip.element.getBoundingClientRect();
      return { key: tip.key.toUpperCase(), x: rect.left, y: rect.top };
    }),
  );

  $effect(() => {
    const restores = tips.map(({ element, key }) => {
      const before = element.getAttribute('aria-description');
      element.setAttribute('aria-description', tr.t('access.tip', { key: key.toUpperCase() }));
      return () => {
        if (before === null) element.removeAttribute('aria-description');
        else element.setAttribute('aria-description', before);
      };
    });
    return () => {
      for (const restore of restores) restore();
    };
  });
</script>

{#each placed as tip, index (index)}
  <span
    class="de-access-tip"
    aria-hidden="true"
    data-access-tip={tip.key}
    style:inset-inline-start={`${Math.max(0, tip.x)}px`}
    style:inset-block-start={`${Math.max(0, tip.y)}px`}>{tip.key}</span
  >
{/each}
