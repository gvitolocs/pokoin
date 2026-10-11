import { DeskPanel, PageHead, Thread } from '../components/Desk.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';

/** /stock. */
export default function Stock() {
  return (
    <SignedIn from="/stock">
      <div class="page desk">
        <PageHead
          kicker="Account"
          title="Stock"
          lede="Your live listings, what you sold, and what you bought."
        >
          <a class="btn" href="/inventory/scan">Scan cards</a>
          <a class="btn ghost" href="/marketplace">Shop</a>
        </PageHead>
        <StockNav />
        <DeskPanel flush title="Go to">
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
