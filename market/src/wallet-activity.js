/** Unified activity feed for the /wallet desk. Firestore `ledger_entries` and
 * `wallet_activity` rows plus PokoinPoS explorer transactions merge into one
 * newest-first feed, deduped by key — the same model as the cardvault wallet. */

export function readActivityDate(value) {
  if (!value) {
    return new Date(0);
  }
  if (typeof value.toDate === 'function') {
    return value.toDate();
  }
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

export function readActivityInt(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount) : 0;
}

const KIND_IN = 'inbound';
const KIND_OUT = 'outbound';

export function activityFromLedgerRow(row = {}) {
  const type = String(row.type || 'account_activity').trim();
  const amount = readActivityInt(row.amountPkn);
  const outbound = amount < 0 || type.includes('sent') || type.includes('withdraw');
  const counterparty = String(row.counterpartyUsername || row.toAddress || row.stripeSessionId || '');
  return {
    key: `ledger:${row.id || type}:${counterparty}:${amount}`,
    title: ledgerTitle(type, amount, counterparty),
    detail: type.startsWith('account_transfer_') ? '' : counterparty || type,
    kind: outbound ? KIND_OUT : KIND_IN,
    amountPkn: amount,
    at: readActivityDate(row.createdAt),
  };
}

function ledgerTitle(type, amount, counterparty) {
  const abs = Math.abs(amount);
  const name = String(counterparty || '').trim();
  if (type === 'account_transfer_sent') {
    return name ? `Sent ${abs} PKN to ${name}` : `Sent ${abs} PKN`;
  }
  if (type === 'account_transfer_received') {
    return name ? `Received ${abs} PKN from ${name}` : `Received ${abs} PKN`;
  }
  if (type === 'account_transfer_payout_pending' || type === 'account_transfer_payout_sent') {
    return `Received ${abs} PKN to wallet`;
  }
  if (type === 'pkn_purchase_credit') {
    return `Bought ${abs} PKN`;
  }
  if (type === 'silver_unlock_payment_sent') {
    return `Silver unlock ${abs} PKN`;
  }
  if (type === 'silver_unlock_payment_received') {
    return `Silver unlock received ${abs} PKN`;
  }
  if (type.includes('withdraw') || type.includes('conversion')) {
    return `Requested ${abs} PKN payout`;
  }
  return `${type}${abs ? ` ${abs} PKN` : ''}`.trim();
}

const LEGACY_TITLE = /from account balance|to account balance|^topped up \d+ pkn$/i;

export function activityFromWalletRow(row = {}) {
  const title = String(row.title || 'Wallet activity')
    .replace(/\s+from account balance\b/gi, '')
    .replace(/\s+from account\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    key: `wallet_activity:${row.id || row.detail || title}`,
    title,
    detail: String(row.detail || ''),
    kind: String(row.kind || '').trim() === KIND_IN ? KIND_IN : KIND_OUT,
    amountPkn: null,
    at: readActivityDate(row.createdAt),
    skip: LEGACY_TITLE.test(String(row.title || '')) || title.toLowerCase() === 'pokoinswap submitted',
  };
}

export function shortChainAddress(address) {
  const value = String(address || '');
  return value.length < 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function activityFromChainTx(tx = {}, address = '') {
  const from = String(tx.from || '').toLowerCase();
  const to = String(tx.to || '').toLowerCase();
  const hash = String(tx.hash || '');
  const outbound = Boolean(address) && from === String(address).toLowerCase();
  const amount = readActivityInt(tx.amount);
  const block = readActivityInt(tx.blockNumber);
  const amm = tx.amm && typeof tx.amm === 'object' ? tx.amm : null;
  const ammAction = String(amm?.action || '').trim().toLowerCase();
  const assetIn = String(amm?.assetIn || '').trim().toUpperCase();
  const assetOut = String(amm?.assetOut || '').trim().toUpperCase();
  const amountIn = readActivityInt(amm?.amountIn);
  const amountOut = readActivityInt(amm?.amountOut);
  const isSwap = ammAction === 'amm_swap' && assetIn && assetOut && amountIn > 0 && amountOut > 0;
  const at = readActivityDate(tx.timestamp);
  return {
    key: `chain:${hash}`,
    title: isSwap
      ? `Swapped ${amountIn} ${assetIn} for ${amountOut} ${assetOut}`
      : `${outbound ? 'Sent' : 'Received'} ${amount} PKN on-chain`,
    detail: hash || `${shortChainAddress(from)} → ${shortChainAddress(to)}`,
    kind: outbound ? KIND_OUT : KIND_IN,
    amountPkn: isSwap ? null : outbound ? -amount : amount,
    at,
    blockLabel: !at.getTime() && block > 0 ? `Block ${block}` : '',
  };
}

/** Merge feeds newest-first, keep the first row per key, drop skipped rows. */
export function mergeActivity(groups, { limit = 12 } = {}) {
  const byKey = new Map();
  for (const group of groups) {
    for (const item of group || []) {
      if (!item || item.skip) {
        continue;
      }
      if (!byKey.has(item.key)) {
        byKey.set(item.key, item);
      }
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** Revolut-style row time: clock time today, short date otherwise. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function activityTimeLabel(at, { now = new Date() } = {}) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime()) || !date.getTime()) {
    return '';
  }
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  const day = date.getDate();
  const month = MONTHS[date.getMonth()];
  return date.getFullYear() === now.getFullYear() ? `${day} ${month}` : `${day} ${month} ${date.getFullYear()}`;
}
