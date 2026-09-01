import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const homeDir = path.resolve(rootDir, '../home');
const rootIcons = {
  '/favicon.ico': 'favicon.ico',
  '/favicon-32x32.png': 'favicon-32x32.png',
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/pokoin-192.png': 'pokoin-192.png',
  '/pokoin-512.png': 'logo.png',
};

function serveLandingHome() {
  return {
    name: 'pokoin-home-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) {
          next();
          return;
        }
        const pathname = decodeURIComponent(req.url.split('?')[0]);
        const iconName = rootIcons[pathname];
        const relative = pathname.startsWith('/home/')
          ? pathname.slice('/home/'.length)
          : iconName || '';
        if (!relative) {
          next();
          return;
        }
        const file = path.resolve(homeDir, relative);
        if (!file.startsWith(homeDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next();
          return;
        }
        const ext = path.extname(file);
        const types = {
          '.png': 'image/png',
          '.ico': 'image/x-icon',
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
    if (url === '/cardscan/identify' || url.startsWith('/chain')) {
      next();
      return;
    }
        if (
      url === '/marketplace' || url.startsWith('/marketplace/')
      || url === '/favorites' || url.startsWith('/favorites/')
      || url === '/product' || url.startsWith('/product/')
      || url === '/forum' || url.startsWith('/forum/')
      || url === '/wallet' || url.startsWith('/wallet/')
      || url === '/cart' || url.startsWith('/cart/')
      || url === '/auth' || url.startsWith('/auth/')
      || url === '/profile' || url.startsWith('/profile/')
      || url === '/scan' || url.startsWith('/scan/')
      || url === '/cardscan' || (url.startsWith('/cardscan/') && url !== '/cardscan/identify')
      || url === '/scancard' || url.startsWith('/scancard/')
      || url === '/inventory' || url.startsWith('/inventory/')
      || url === '/docs' || url.startsWith('/docs/')
      || url === '/about' || url.startsWith('/about/')
      || url === '/contact' || url.startsWith('/contact/')
      || url === '/privacy' || url.startsWith('/privacy/')
      || url === '/buy' || url.startsWith('/buy/')
      || url === '/admin' || url.startsWith('/admin/')
      || url === '/earn' || url.startsWith('/earn/')
      || url === '/whitepaper' || url.startsWith('/whitepaper/')
      || url === '/health' || url.startsWith('/health/')
      || url === '/nft' || url.startsWith('/nft/')
      || url === '/swap' || url.startsWith('/swap/')
      || url === '/checkout' || url.startsWith('/checkout/')
      || url === '/orders' || url.startsWith('/orders/')
      || url === '/collection' || url.startsWith('/collection/')
    ) {
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
      '/chain': {
        target: 'https://rpc.pokoin.com',
        changeOrigin: true,
      },
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
