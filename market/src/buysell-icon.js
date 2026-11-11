/**
 * The BuySell mark, 24×24, as two paths so each arrow takes its own colour:
 * BUYSELL_BUY points right along the top (gold, --buysell-buy), BUYSELL_SELL points
 * left along the bottom (--buysell-sell). BUYSELL_ICON is both as one path, for a
 * one-colour use. Single source of the shapes; solid/src/components/buysell/BuySellIcon.jsx draws them.
 */
export const BUYSELL_BUY = 'M21 9l-3.99-4v3H10v2h7.01v3L21 9z';
export const BUYSELL_SELL = 'M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3z';
export const BUYSELL_ICON = `${BUYSELL_SELL}${BUYSELL_BUY}`;
