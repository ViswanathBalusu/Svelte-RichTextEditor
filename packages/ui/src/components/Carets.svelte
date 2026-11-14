<!--
  Collaborators' carets and selections with name flags (UX-027; 13 §5; 02 §3 forced colours). The
  core maps each peer's position through the local steps and reports rectangles relative to the
  element the body is mounted in; a peer whose position cannot be mapped has no caret and is not
  drawn. The layer lies over the page, takes no pointer events and no focus, and is hidden from
  assistive technology, which hears arrivals and departures from the header's presence list. The
  flag names the person in text (from the host's directory, UX-025); the colour only repeats the
  avatar's. The view holds no peer inside hidden content (ADR 0019).
-->
<script lang="ts">
  import type { PeerCaret, ReadView } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { drawnPeers } from '../shell/carets.ts';

  interface Props {
    carets: ReadView<readonly PeerCaret[]>;
  }

  let { carets }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  // svelte-ignore state_referenced_locally
  const view = live(carets);
  const directory = live(shell.people.view);

  // A peer whose caret cannot be mapped is not drawn at all (drawnPeers, UX-027 criterion 3).
  const peers = $derived.by(() => {
    void directory.current;
    return drawnPeers(view.current).map((p) => ({
      ...p,
      label: shell.people.lookup(p.user, p.name).name ?? tr.t('people.fallback'),
    }));
  });

  $effect(() => {
    shell.people.request(view.current.map((p) => p.user));
  });
</script>

<!-- The core's coordinates are physical, from the left: the layer is a coordinate space, not text. -->
<div class="de-carets" aria-hidden="true" dir="ltr">
  {#each peers as peer (peer.session)}
    {#each peer.selection as rect, i (i)}
      <div
        class="de-peer-selection de-person-{peer.slot}"
        data-session={peer.session}
        style:inset-block-start={`${rect.y}px`}
        style:inset-inline-start={`${rect.x}px`}
        style:inline-size={`${rect.width}px`}
        style:block-size={`${rect.height}px`}
      ></div>
    {/each}
    <div
      class="de-peer-caret de-person-{peer.slot}"
      data-session={peer.session}
      data-status={peer.status}
      style:inset-block-start={`${peer.caret.y}px`}
      style:inset-inline-start={`${peer.caret.x}px`}
      style:block-size={`${peer.caret.height}px`}
    >
      <span class="de-peer-flag de-person-{peer.slot}" data-content dir="auto"
        >{peer.status === 'idle'
          ? tr.t('presence.person.idle', { name: peer.label })
          : tr.t('presence.person.active', { name: peer.label })}</span
      >
    </div>
  {/each}
</div>
