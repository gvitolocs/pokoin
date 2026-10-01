'use strict';
const { readTcgplayerHistory } = require('./_tcgcsv_prices');

function parseRange(params) {
  const cardId = params.get('cardId') || '';
  const from = params.get('from') || '2024-02-08';
  const to = params.get('to') || new Date().toISOString().slice(0,10);
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  if (!/^[1-9]\d{0,17}$/.test(cardId) || !validDate(from) || !validDate(to)
      || from > to || from < '2024-01-01' || Number(new Date(to))-Number(new Date(from)) > 3660*86400000) {
    const error = new Error('Valid cardId and date range required (YYYY-MM-DD, maximum 10 years).');
    error.statusCode=400; throw error;
  }
  return {cardId,from,to};
}

module.exports = async function handler(req,res) {
  if (req.method !== 'GET') { res.setHeader('Allow','GET'); return res.status(405).json({error:'Method not allowed.'}); }
  try {
    await require('./_firebase').verifyBearerToken(req);
    const url = new URL(req.url,`https://${req.headers.host || 'pokoin.com'}`);
    const {cardId,from,to} = parseRange(url.searchParams);
    const game = require('./_marketplace_game').currentGame();
    const result = await readTcgplayerHistory(game,cardId,from,to);
    res.setHeader('Cache-Control','private, max-age=60');
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.statusCode || 503).json({error: error.statusCode ? error.message : 'TCGplayer history unavailable.'});
  }
};
module.exports.parseRange = parseRange;
