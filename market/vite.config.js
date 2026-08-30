import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const homeDir = path.resolve(rootDir, '../home');

function serveLandingHome() {
  return {
    name: 'pokoin-home-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/home/')) {
          next();
          return;
        }
        const relative = decodeURIComponent(req.url.split('?')[0].slice('/home/'.length));
        const file = path.resolve(homeDir, relative);
        if (!file.startsWith(homeDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next();
          return;
        }
        const ext = path.extname(file);
        const types = {
          '.png': 'image/png',
          '.woff2': 'font/woff2',
          '.css': 'text/css',
          '.js': 'text/javascript',
        };
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

function marketplaceSpa() {
  return {
    name: 'marketplace-spa-fallback',
    configureServer: rewriteMarketplace,
    configurePreviewServer: rewriteMarketplace,
  };
}

function rewriteMarketplace(server) {
  server.middlewares.use((req, res, next) => {
    const url = req.url?.split('?')[0] || '';
    if (url === '/marketplace' || url.startsWith('/marketplace/')) {
      req.url = '/index.html';
    }
    next();
  });
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/market/' : '/',
  plugins: [react(), serveLandingHome(), marketplaceSpa()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    proxy: {
      '/api': {
        target: 'https://api.pokoin.com',
        changeOrigin: true,
      },
      '/card-images': {
        target: 'https://cdn.pokoin.com',
        changeOrigin: true,
        rewrite: (pathname) => pathname.replace(/^\/card-images/, ''),
      },
    },
  },
}));
