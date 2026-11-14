/**
 * `vite build` in this package builds the library (FE-002; scripts/vite-configs.ts). The package's
 * `build` script runs scripts/build.ts instead, which adds the PDF viewer's page and the size report.
 */
import { defineConfig } from 'vite';
import { libraryConfig } from './scripts/vite-configs.ts';

export default defineConfig(libraryConfig());
