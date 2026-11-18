import { DeskPanel, Thread } from '../components/Desk.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';

/** /stock. */
export default function Stock() {
  return (
    <SignedIn early from="/stock">
      <div class="page desk mypokoin">
        <StockNav title="Stock" lede="Live listings, what you sold, and what you bought.">
          <a class="btn" href="/inventory/scan">Scan cards</a>
          <a class="btn ghost" href="/marketplace">Shop</a>
        </StockNav>
        <DeskPanel flush title="Go to">
          <p class="mypokoin-help">Jump to listings, sold history, or the cards you bought.</p>
          <div class="thread-list">
            <Thread to="/mypokoin" title="MyPokoin" meta="Live listings for Pokémon" />
            <Thread to="/sales" title="Sold history" meta="Pokoin checkout and CardTrader sales" />
            <Thread to="/bought" title="Buy history" meta="Orders you paid for as a buyer" />
          </div>
        </DeskPanel>
      </div>
    </SignedIn>
  );
}
