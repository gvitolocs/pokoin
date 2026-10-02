'use strict';

const { EventEmitter } = require('node:events');

const bus = new EventEmitter();
bus.setMaxListeners(0);
const clients = new Set();

function publishListing(event) {
  const payload = {
    type: 'listing',
    cardId: event.cardId ? String(event.cardId) : '',
    listingId: event.listingId ? String(event.listingId) : '',
    sellerUid: event.sellerUid ? String(event.sellerUid) : '',
    quantityAvailable: Number(event.quantityAvailable),
    status: event.status ? String(event.status) : '',
    at: Date.now(),
  };
  bus.emit('listing', payload);
  const frame = `event: listing\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    if (client.cardId && payload.cardId && client.cardId !== payload.cardId) continue;
    if (client.sellerUid && payload.sellerUid && client.sellerUid !== payload.sellerUid) continue;
    try {
      client.res.write(frame);
    } catch (_) {
      clients.delete(client);
    }
  }
  return payload;
}

function subscribe(res, filter = {}) {
  const client = {
    res,
    cardId: String(filter.cardId || ''),
    sellerUid: String(filter.sellerUid || ''),
  };
  clients.add(client);
  return () => clients.delete(client);
}

function clientCount() {
  return clients.size;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method not allowed.');
  }
  const url = new URL(req.url, 'http://localhost');
  const cardId = String(url.searchParams.get('cardId') || '').trim();
  const sellerUid = String(url.searchParams.get('sellerUid') || '').trim();
  if (!cardId && !sellerUid) {
    return res.status(400).json({ error: 'cardId or sellerUid is required.' });
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': ok\n\n');
  const unsubscribe = subscribe(res, { cardId, sellerUid });
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 15000);
  ping.unref?.();
  // oracle-api-server ends the response when the handler resolves.
  return new Promise((resolve) => {
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      resolve();
    });
  });
};

module.exports.publishListing = publishListing;
module.exports.subscribe = subscribe;
module.exports.clientCount = clientCount;
module.exports.bus = bus;
