export function defaultInventoryTargets(connected) {
  if (connected) {
    return { pokoin: true, cardtrader: true };
  }
  return { pokoin: true, cardtrader: false };
}

export function inventoryTargetsLabel(counts, { intent = 'list', targets, verb = 'Add' } = {}) {
  const n = Number(counts?.cards ?? counts?.qty ?? 1) || 0;
  const noun = n === 1 ? 'card' : 'cards';
  if (intent === 'collection') {
    return `${verb} ${n} ${noun} to collection`;
  }
  const pokoin = targets?.pokoin !== false;
  const cardtrader = targets?.cardtrader === true;
  if (pokoin && cardtrader) {
    return `${verb} ${n} ${noun} to Pokoin + CardTrader`;
  }
  if (cardtrader && !pokoin) {
    return `${verb} ${n} ${noun} to CardTrader`;
  }
  if (intent === 'list' && verb === 'List') {
    return `List ${n === 1 ? 'card' : `${n} cards`} on Pokoin`;
  }
  return `${verb} ${n} ${noun} to Pokoin`;
}
