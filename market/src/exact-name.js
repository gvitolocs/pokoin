export function exactNameQuery(name) {
  const trimmed = String(name || '').trim().replace(/"/g, '');
  return trimmed ? `"${trimmed}"` : '';
}

export function namesEqual(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

export function filterExactNameRows(cards, name, { excludeId } = {}) {
  const skip = excludeId != null && String(excludeId) !== '' ? String(excludeId) : '';
  const seen = new Set();
  const rows = [];
  for (const row of cards || []) {
    const id = String(row.id || row.card_id || '');
    if (!id || !namesEqual(row.name, name)) {
      continue;
    }
    if (skip && id === skip) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    rows.push(row);
  }
  return rows;
}
