// The build targets the declared minimum browser versions (02 §12; FE-116, criterion 1).
import { describe, expect, it } from 'vitest';
import {
  BROWSER_MINIMUMS,
  demoConfig,
  libraryConfig,
  svelteHostConfig,
  viewerConfig,
} from '../scripts/vite-configs.ts';

describe('declared browser minimums', () => {
  it('names Chrome and Edge 137, Firefox 142 and Safari 17', () => {
    expect([...BROWSER_MINIMUMS]).toEqual(['chrome137', 'edge137', 'firefox142', 'safari17']);
  });

  it('gives every component build those minimums as its target', () => {
    const configs = [
      libraryConfig(),
      viewerConfig(),
      demoConfig('tree', false),
      svelteHostConfig(),
    ];
    for (const config of configs) {
      expect(config.build?.target).toEqual([...BROWSER_MINIMUMS]);
    }
  });
});
