import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const marketDir = path.resolve(rootDir, '../market');
const homeDir = path.resolve(rootDir, '../home');

/** Root icons the landing serves from home/ (same map as market/vite.config.js). */
const rootIcons = {
  '/favicon.ico': 'favicon.ico',
  '/favicon-32x32.png': 'favicon-32x32.png',
  '/favicon-48x48.png': 'favicon-48x48.png',
  '/favicon-96x96.png': 'favicon-96x96.png',
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/pokoin-192.png': 'pokoin-192.png',
  '/pokoin-512.png': 'logo.png',
};

const TYPES = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

/** Dev only: /home/* and root icons come from the landing tree, like production. */
function serveLandingHome() {
  return {
    name: 'pokoin-home-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = decodeURIComponent(String(req.url || '').split('?')[0]);
        const relative = pathname.startsWith('/home/')
          ? pathname.slice('/home/'.length)
          : rootIcons[pathname] || '';
        if (!relative) return next();
        const file = path.resolve(homeDir, relative);
        if (!file.startsWith(homeDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * Rolldown splits every module shared by the entry and a lazy chunk into its
 * own common chunk, so lazy trays / chat / previews turned the first paint
 * into ~19 module requests. Everything statically reachable from the entry
 * is loaded on the first paint anyway: keep it in one chunk, lazy-only code
 * stays split.
 */
function entryGroup(id, ctx) {
  const seen = new Set();
  const walk = (moduleId) => {
    if (seen.has(moduleId)) return false;
    seen.add(moduleId);
    const info = ctx.getModuleInfo(moduleId);
    if (!info) return false;
    if (info.isEntry) return true;
    return info.importers.some(walk);
  };
  return walk(id) ? 'index' : null;
}

/** The Solid app must never bundle React. Shared modules come from market/src,
 * so a hook import there would silently drag react-dom in; fail the build instead. */
const FORBIDDEN = /^(react|react-dom|react-router|react-router-dom)(\/|$)/;
function forbidReact() {
  return {
    name: 'pokoin-forbid-react',
    enforce: 'pre',
    resolveId(source, importer) {
      if (FORBIDDEN.test(source) && process.env.SOLID_ALLOW_REACT !== '1') {
        throw new Error(`Solid app imported "${source}" from ${importer || '?'} — split the React hook out of that shared module.`);
      }
      return null;
    },
  };
}

/**
 * Prefetch (idle priority, no evaluation) the chunks only the typeahead engine
 * needs, so the first search focus evaluates them without waiting on the
 * network — and the cold page load never evaluates them at all.
 */
function prefetchSuggestEngine() {
  let base = '/';
  return {
    name: 'pokoin-prefetch-suggest-engine',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return undefined;
        const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
        const engine = chunks.find((chunk) => chunk.facadeModuleId?.endsWith('/src/lib/suggest-engine.js'));
        const entry = chunks.find((chunk) => chunk.isEntry);
        if (!engine) return undefined;
        const walk = (name, seen) => {
          if (seen.has(name)) return seen;
          seen.add(name);
          for (const dep of bundle[name]?.imports || []) walk(dep, seen);
          return seen;
        };
        const eager = entry ? walk(entry.fileName, new Set()) : new Set();
        return [...walk(engine.fileName, new Set())]
          .filter((file) => !eager.has(file))
          .map((file) => ({
            tag: 'link',
            attrs: { rel: 'prefetch', href: `${base}${file}`, as: 'script', crossorigin: '' },
            injectTo: 'head',
          }));
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  // Same base as the React build: shared modules build asset URLs from
  // import.meta.env.BASE_URL (flags, game icons, data/catalog.json) that the
  // React build already publishes under /market/. Only Solid chunks move to /market/s/.
  base: command === 'build' ? '/market/' : '/',
  publicDir: command === 'build' ? false : path.join(marketDir, 'public'),
  plugins: [forbidReact(), solid(), serveLandingHome(), prefetchSuggestEngine()],
  resolve: {
    alias: { '@market': path.join(marketDir, 'src') },
    dedupe: ['solid-js', '@solidjs/web', '@solidjs/signals'],
  },
  build: {
    target: 'es2022',
    assetsDir: 's',
    sourcemap: process.env.SOLID_SOURCEMAP === '1',
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: entryGroup }] } },
    },
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 5175,
    fs: { allow: [rootDir, marketDir, homeDir] },
    proxy: {
      '/api': {
        target: process.env.POKOIN_API_PROXY || 'https://api.pokoin.com',
        changeOrigin: true,
      },
      '/chain': { target: 'https://rpc.pokoin.com', changeOrigin: true },
      '/cardscan/identify': {
        target: 'https://cardscan.pokoin.com',
        changeOrigin: true,
        rewrite: () => '/identify',
      },
      '/card-images': {
        target: 'https://cdn.pokoin.com',
        changeOrigin: true,
        rewrite: (pathname) => pathname.replace(/^\/card-images/, ''),
      },
    },
  },
}));
