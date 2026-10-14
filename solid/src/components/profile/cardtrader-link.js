/**
 * CardTrader inventory link: which way new stock is copied once CardTrader is
 * connected (server: pokoin-rust crates/external/src/cardtrader/link.rs). The
 * reconcile runs every ~10 minutes and after each change here.
 */
export const CT_LINK_DIRECTIONS = [
  {
    id: 'ct_to_pokoin',
    label: 'CardTrader → Pokoin',
    hint: 'Your CardTrader stock is imported here and kept up to date. New CardTrader listings show up within about 10 minutes.',
  },
  {
    id: 'pokoin_to_ct',
    label: 'Pokoin → CardTrader',
    hint: 'Cards you list on Pokoin are listed on CardTrader too, a batch every 10 minutes. CardTrader-only stock stays off Pokoin.',
  },
  {
    id: 'both',
    label: 'Both ways',
    hint: 'New stock on either side is copied to the other.',
  },
];

export const DEFAULT_CT_LINK_DIRECTION = 'ct_to_pokoin';

/** The stored direction from a CardTrader status, or the default. */
export function ctLinkDirection(status) {
  const id = status?.inventorySync?.direction;
  return CT_LINK_DIRECTIONS.some((option) => option.id === id) ? id : DEFAULT_CT_LINK_DIRECTION;
}

export function ctLinkOption(id) {
  return CT_LINK_DIRECTIONS.find((option) => option.id === id) || CT_LINK_DIRECTIONS[0];
}

function ago(at, now) {
  const ms = Date.parse(at || '');
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** One status line for the link: `{ tone: live | syncing | warn | idle, text }`. */
export function ctLinkHealth({ syncing = false, sync = null, now = Date.now() } = {}) {
  if (syncing) return { tone: 'syncing', text: 'Syncing now' };
  if (sync?.lastSyncOk === false) {
    const reason = String(sync.lastSyncError || '').trim();
    return { tone: 'warn', text: reason ? `Last check failed: ${reason}` : 'Last check failed' };
  }
  const when = ago(sync?.lastSyncAt, now);
  if (when) return { tone: 'live', text: `Linked · checked ${when}` };
  return { tone: 'idle', text: 'Linked · first check within 10 minutes' };
}

function count(value) {
  return Number(value || 0);
}

/** The last sync in one line. */
export function formatSyncSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  if (summary.mode === 'one_day_ready') {
    const hidden = count(summary.hiddenListings);
    return [
      `${count(summary.assetCards)} cards on your Dashboard as CardTrader 1-DR`,
      `${count(summary.assets)} products`,
      hidden ? `${hidden} Pokoin listings hidden` : '',
    ].filter(Boolean).join(' · ');
  }
  const pushed = summary.pushedToCardTrader;
  const importing = summary.direction !== 'pokoin_to_ct';
  return [
    `${count(summary.pokemonInventory || summary.inventory)} products checked`,
    importing ? `${count(summary.imported)} imported` : '',
    `${count(summary.matchedExisting)} linked`,
    `${count(summary.updated)} updated`,
    `${count(summary.removed)} removed`,
    `${count(summary.unresolved)} unresolved`,
    pushed ? `${count(pushed.pushed)} listed on CardTrader` : '',
    pushed && count(pushed.failed) ? `${count(pushed.failed)} refused by CardTrader` : '',
  ].filter(Boolean).join(' · ');
}
