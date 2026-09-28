import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { DeskPanel, PageHead, SessionWait, Thread } from '../components/Desk.jsx';
import StockNav from '../components/StockNav.jsx';

export default function Stock() {
  const location = useLocation();
  const { ready, signedIn } = useAuth();

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/stock')} replace />;
  }

  return (
    <div className="page desk">
      <PageHead
        kicker="Account"
        title="Stock"
        lede="Your live listings, what you sold, and what you bought."
      >
        <Link className="btn" to="/inventory/scan">Scan cards</Link>
        <Link className="btn ghost" to="/marketplace">Shop</Link>
      </PageHead>
      <StockNav />
      <DeskPanel flush title="Go to">
        <div className="thread-list">
          <Thread to="/inventory" title="Inventory" meta="Live My listings across this TCG" />
          <Thread to="/sales" title="Sold history" meta="Pokoin checkout and CardTrader sales" />
          <Thread to="/bought" title="Buy history" meta="Orders you paid for as a buyer" />
        </div>
      </DeskPanel>
    </div>
  );
}
