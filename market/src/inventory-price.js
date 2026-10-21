import { knownGameId } from './game.js';
import { formatPknNumber } from './pkn.js';

function positive(value) {
  const number = Number(value);
  return value != null && Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Facet flags of a listing or holding, in the server's order
 * (`price_check_key`): `R` reverse holo (the foil of the other games),
 * `F` first edition, `H` foil, `G` graded, `S` signed, `A` altered.
 */
function finishFlags(row) {
  const foilState = String(row?.foilState || row?.foil_state || '').toLowerCase();
  return [
    [row?.reverse === true || foilState === 'reverse', 'R'],
    [row?.firstEdition === true || row?.first_edition === true, 'F'],
    [row?.foil === true || foilState === 'foil', 'H'],
    [row?.graded === true, 'G'],
    [row?.signed === true, 'S'],
    [row?.altered === true, 'A'],
  ].filter(([on]) => on).map(([, flag]) => flag).join('');
}

/** The game a row's card id belongs to: card ids are per game. */
export function priceGame(row, fallback = 'pokemon') {
  return knownGameId(row?.marketplaceGame || row?.marketplace_game) || knownGameId(fallback) || 'pokemon';
}

/**
 * A listing's condition as the pricer's CardTrader condition key: Pokoin's
 * LP / HP / PO are CardTrader's SP / PL / Poor (server: `condition_key`).
 */
export function pricerCondition(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return '';
  if (['M', 'MT', 'MINT', 'NM', 'NEAR MINT'].includes(value)) return 'NM';
  if (['SP', 'LP', 'EX', 'EXCELLENT', 'SLIGHTLY PLAYED', 'LIGHTLY PLAYED'].includes(value)) return 'SP';
  if (['MP', 'GD', 'GOOD', 'MODERATELY PLAYED'].includes(value)) return 'MP';
  if (['PL', 'HP', 'PLD', 'PLAYED', 'HEAVILY PLAYED'].includes(value)) return 'PL';
  if (['PO', 'POOR', 'DMG', 'DAMAGED'].includes(value)) return 'Poor';
  return value;
}

/** One price-check item: card, condition, language and facet flags. */
export function priceCheckItem(row) {
  const flags = finishFlags(row);
  return {
    cardId: String(row?.cardId || row?.card_id || row?.blueprintId || ''),
    condition: pricerCondition(row?.condition || 'NM'),
    language: String(row?.language || '').toUpperCase(),
    reverse: flags.includes('R'),
    firstEdition: flags.includes('F'),
    foil: flags.includes('H'),
    graded: flags.includes('G'),
    signed: flags.includes('S'),
    altered: flags.includes('A'),
  };
}

/**
 * `card:CONDITION:LANGUAGE:FLAGS`, the key the price check returns a comp
 * under (server: `price_check_key`), so a reverse, graded or signed copy
 * never reads the plain copy's comp.
 */
export function priceCheckKey(row) {
  const item = priceCheckItem(row);
  return `${item.cardId}:${item.condition}:${item.language}:${finishFlags(item)}`;
}

export function inventoryMarketValue(prices, row, source) {
  const entry = prices[priceCheckKey(row)] || prices[String(row?.cardId || row?.card_id || '')];
  if (!entry) return null;
  if (source === 'tcgplayer') {
    const quotes = (entry.tcgplayer || []).filter((quote) => positive(quote.marketPrice) != null);
    if (!quotes.length) return null;
    const values = quotes.map((quote) => Number(quote.marketPrice));
    return {
      currency: 'USD', low: Math.min(...values), high: Math.max(...values),
      title: quotes.map((quote) => `${quote.subtype || 'Standard'}: $${quote.marketPrice} (${quote.sourceTimestamp || 'date unavailable'})`).join('\n')
        + '\nTCGplayer aggregate market quotes in USD; condition is unspecified. Variants remain separate; no conversion to PKN.',
    };
  }
  if (source === 'cardtrader') {
    // Only the cheapest professional seller with the same condition,
    // language and finishes counts: another condition, a private one-off
    // ask, or the plain copy of a reverse card is not this card's price.
    // The other games read the extension's price file: CardTrader Zero
    // sellers, this condition or better.
    const value = positive(entry.ctMatchedPkn);
    if (value == null) return null;
    return {
      currency: 'PKN', value,
      title: entry.ctBasis === 'zero'
        ? 'Cheapest CardTrader Zero seller with the same language and finish, in this condition or better (nightly price file).'
        : 'Cheapest professional CardTrader seller with the same condition, language and finish (latest daily dump).',
    };
  }
  const native = positive(entry.pokoinCheapestPkn);
  const sold = positive(entry.soldMedianPkn);
  const value = native ?? sold;
  return value == null ? null : {
    currency: 'PKN', value,
    title: native != null ? 'Cheapest active Pokoin listing.' : 'CardTrader 30-day inferred-sale median; no active Pokoin listing.',
  };
}

export function inventoryMarketLabel(value) {
  if (!value) return '—';
  if (value.currency === 'USD') {
    const format = (amount) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
    return `${format(value.low)}${value.high !== value.low ? `–${format(value.high)}` : ''} USD`;
  }
  return `${formatPknNumber(value.value, { maximumFractionDigits: 0 })} PKN`;
}
