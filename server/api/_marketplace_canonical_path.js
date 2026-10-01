'use strict';

const { slugPart } = require('./_slug');

function cleanCardId(value) {
  const id = Number(String(value || '').trim());
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function publicCardIdForRow(row = {}) {
  const cardId = cleanCardId(row.card_id ?? row.id);
  const ctId = cleanCardId(row.ct_id ?? row.ctId);
  if (ctId) {
    return ctId * 2;
  }
  if (!cardId) {
    return 0;
  }
  return cardId % 2 === 1 ? cardId * 2 : cardId;
}

function cleanCollectorNumber(value, cardId) {
  const text = String(value || '')
    .trim()
    .replace(/^#+\s*/, '');
  if (!text || text === String(cardId || '').trim()) {
    return '';
  }
  return text;
}

function canonicalSlugForRow(row = {}) {
  const parts = [
    String(row.rarity || '').trim() || 'Card',
    row.display_name || row.canonical_name || row.name,
    cleanCollectorNumber(row.card_number, row.card_id),
    row.set_name,
  ];
  return parts.map(slugPart).filter(Boolean).join('-');
}

function canonicalPathForRow(row = {}) {
  const storedPath = String(row.canonical_path || row.canonicalPath || '').trim();
  if (storedPath.startsWith('/marketplace/') && storedPath.includes('/cards/')) {
    return storedPath;
  }
  const cleanId = publicCardIdForRow(row);
  const slug = canonicalSlugForRow(row);
  return cleanId && slug ? `/marketplace/en/cards/${cleanId}/${slug}` : '';
}

module.exports = {
  cleanCardId,
  publicCardIdForRow,
  cleanCollectorNumber,
  canonicalSlugForRow,
  canonicalPathForRow,
};
