'use strict';

function tcgplayerProductUrl(productId) {
  const id = String(productId || '').replace(/\D/g, '');
  return id ? `https://www.tcgplayer.com/product/${id}` : '';
}

function cleanCardId(value) {
  const id = String(value || '').trim();
  return /^\d+$/.test(id) ? id : '';
}

function sendProduct(res, productId, wantsJson) {
  const url = tcgplayerProductUrl(productId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (wantsJson) {
    return res.status(200).json({ url, productId: String(productId) });
  }
  res.setHeader('Location', url);
  return res.status(302).end();
}

function createHandler(deps = {}) {
  const lookup = deps.readTcgplayerProductId
    || ((game, cardId) => require('./_tcgcsv_prices').readTcgplayerProductId(game, cardId));
  const gameOf = deps.parseGameFromRequest
    || ((req) => require('./_marketplace_game').parseGameFromRequest(req));
  const run = deps.runWithGame
    || ((game, fn) => require('./_marketplace_game').runWithGame(game, fn));
  const activeGame = deps.currentGame
    || (() => require('./_marketplace_game').currentGame());

  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    const game = gameOf(req);
    return run(game, async () => {
      const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
      const id = cleanCardId(url.searchParams.get('id') || url.searchParams.get('cardId'));
      if (!id) {
        return res.status(400).json({ error: 'Missing or invalid card id.' });
      }
      const wantsJson = url.searchParams.get('format') === 'json';
      try {
        const productId = await lookup(activeGame(), id);
        if (!productId) {
          return res.status(404).json({ error: 'No TCGplayer product for this card.', id });
        }
        return sendProduct(res, productId, wantsJson);
      } catch (error) {
        console.error('tcgplayer-redirect lookup failed', error);
        return res.status(error.statusCode || 500).json({
          error: error.message || 'TCGplayer redirect failed.',
        });
      }
    });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.tcgplayerProductUrl = tcgplayerProductUrl;
