/**
 * The Vue host (FE-124 criterion 1): Vue 3 renders a `<doc-editor>` with a render function. The
 * `.backend` key sets the property and `doc-id` the attribute, as a template's `.prop` would.
 */
import { createApp, defineComponent, h, onMounted, ref, version } from 'vue';
import { startHost, type HostFixtures } from '../fixtures.ts';

function component(host: HostFixtures) {
  return defineComponent({
    setup() {
      const clicks = ref(0);
      onMounted(() => {
        host.status.rendered = true;
      });
      return () =>
        h('main', [
          h(
            'button',
            { id: 'host-button', type: 'button', onClick: () => clicks.value++ },
            `Host clicks: ${clicks.value}`,
          ),
          clicks.value > 0 ? h('p', { id: 'host-clicked' }, `Clicked ${clicks.value} times`) : null,
          h('doc-editor', {
            'doc-id': host.docId,
            '.backend': host.backend,
            'data-test': 'host',
          }),
        ]);
    },
  });
}

const host = await startHost('vue', version);
createApp(component(host)).mount('#host-app');
