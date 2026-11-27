/**
 * The React host (FE-124 criterion 1): React 19 renders a `<doc-editor>` with createElement (no JSX
 * build step is needed), sets its `doc-id` as an attribute and its `backend` as a property, which
 * is how React 19 passes props to a custom element that defines them.
 */
import { createElement, useEffect, useState, version } from 'react';
import { createRoot } from 'react-dom/client';
import { startHost, type HostFixtures } from '../fixtures.ts';

function App({ host }: { host: HostFixtures }) {
  const [clicks, setClicks] = useState(0);
  useEffect(() => {
    host.status.rendered = true;
  }, [host]);
  return createElement(
    'main',
    null,
    createElement(
      'button',
      { id: 'host-button', type: 'button', onClick: () => setClicks((n) => n + 1) },
      `Host clicks: ${clicks}`,
    ),
    clicks > 0 ? createElement('p', { id: 'host-clicked' }, `Clicked ${clicks} times`) : null,
    createElement('doc-editor', {
      'doc-id': host.docId,
      backend: host.backend,
      'data-test': 'host',
    }),
  );
}

const host = await startHost('react', version);
createRoot(document.getElementById('host-app')!).render(createElement(App, { host }));
