// Cart row tick + totals: the small part of cart-model.js the header's cart
// badge needs on the first paint (cart-model.js re-exports these).

/** Rows default to selected, like Amazon's basket; only an explicit false opts out. */
export function isSelected(row) {
  return row?.selected !== false;
}

export function rowQty(row) {
  return Math.max(0, Math.trunc(Number(row?.qty) || 0));
}

export function rowTotalPkn(row) {
  return (Number(row?.pricePkn) || 0) * rowQty(row);
}

/** Header badge counts every copy; the Subtotal counts only the ticked rows. */
export function cartTotals(items = []) {
  const totals = {
    lines: 0,
    count: 0,
    subtotalPkn: 0,
    selectedLines: 0,
    selectedCount: 0,
    selectedSubtotalPkn: 0,
    allSelected: false,
  };
  for (const row of items || []) {
    const qty = rowQty(row);
    const line = rowTotalPkn(row);
    totals.lines += 1;
    totals.count += qty;
    totals.subtotalPkn += line;
    if (isSelected(row)) {
      totals.selectedLines += 1;
      totals.selectedCount += qty;
      totals.selectedSubtotalPkn += line;
    }
  }
  totals.allSelected = totals.lines > 0 && totals.selectedLines === totals.lines;
  return totals;
}
