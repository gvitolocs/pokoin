import { Link } from 'react-router-dom';

export const SELL_SPREADSHEET_PATH = '/mypokoin/spreadsheet';

function SheetIcon() {
  return (
    <svg viewBox="0 0 48 48" width="34" height="34" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 6h16l8 8v26a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm14 2v8h8"
      />
      <path fill="currentColor" d="M16 24h7v2h-7v-2zm0 5h16v2H16v-2zm0 5h16v2H16v-2z" />
      <path fill="currentColor" d="M29.2 22.4 33 26.2l3.8-3.8 1.4 1.4-3.8 3.8 3.8 3.8-1.4 1.4-3.8-3.8-3.8 3.8-1.4-1.4 3.8-3.8-3.8-3.8z" />
    </svg>
  );
}

/** Sell-and-buy tile that opens the spreadsheet import desk. */
export default function SellSpreadsheetTile() {
  return (
    <Link className="sell-sheet-tile" to={SELL_SPREADSHEET_PATH} data-testid="sell-via-spreadsheet">
      <span className="sell-sheet-tile-icon"><SheetIcon /></span>
      <strong>Sell via spreadsheet</strong>
      <span>Start selling by uploading an excel/csv file</span>
    </Link>
  );
}
