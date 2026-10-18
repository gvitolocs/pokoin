import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';

/**
 * The landing island (src/landing/island.jsx): the static index.html loads it
 * as /market/landing-island.js, which scripts/build-web.sh rewrites to the
 * hashed entry named in dist/landing-manifest.json. Built after the SPA into
 * the same dist/ (chunks under /market/s/, immutable), sharing nothing with
 * the SPA bundle so neither changes the other's chunking.
 */
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const marketDir = path.resolve(rootDir, '../market');

export default defineConfig({
  base: '/market/',
  publicDir: false,
  plugins: [solid()],
  resolve: {
    alias: { '@market': path.join(marketDir, 'src') },
    dedupe: ['solid-js', '@solidjs/web', '@solidjs/signals'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    assetsDir: 's',
    manifest: 'landing-manifest.json',
    sourcemap: process.env.SOLID_SOURCEMAP === '1',
    rolldownOptions: {
      input: { 'landing-island': path.join(rootDir, 'src/landing/island.jsx') },
    },
  },
});
