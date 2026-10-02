'use strict';
const { parseRange, readCardPriceHistory } = require('./_card_price_history');

function createHandler(dependencies = {}) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    try {
      const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
      const range = parseRange(url.searchParams);
      const game = dependencies.currentGame ? dependencies.currentGame()
        : require('./_marketplace_game').currentGame();
      const result = await (dependencies.readCardPriceHistory || readCardPriceHistory)({ game, ...range });
      res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=120');
      return res.status(200).json(result);
    } catch (error) {
      return res.status(error.statusCode || 503).json({
        error: error.statusCode ? error.message : 'Card price history unavailable.',
      });
    }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
