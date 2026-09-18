import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import { CartProvider } from './cart.jsx';
import { WalletProvider } from './wallet.jsx';
import Chrome from './components/Chrome.jsx';
import Home from './pages/Home.jsx';
import Sanitize from './pages/Sanitize.jsx';
import Espurr from './pages/Espurr.jsx';
import Ocr from './pages/Ocr.jsx';
import OcrArtists from './pages/OcrArtists.jsx';
import ArtworkHover from './pages/ArtworkHover.jsx';
import TestsDashboard from './pages/TestsDashboard.jsx';
import Search from './pages/Search.jsx';
import Card from './pages/Card.jsx';
import Expansion from './pages/Expansion.jsx';
import Competitive from './pages/Competitive.jsx';
import CompetitiveTournaments from './pages/CompetitiveTournaments.jsx';
import CompetitiveDecks from './pages/CompetitiveDecks.jsx';
import CompetitiveDecklist from './pages/CompetitiveDecklist.jsx';
import CompetitivePlayers from './pages/CompetitivePlayers.jsx';
import CompetitiveCards from './pages/CompetitiveCards.jsx';
import Portfolio from './pages/Portfolio.jsx';
import Explore from './pages/Explore.jsx';
import Watchlist from './pages/Watchlist.jsx';
import Sets from './pages/Sets.jsx';
import Era from './pages/Era.jsx';
import Versions from './pages/Versions.jsx';
import Artist from './pages/Artist.jsx';
import PokemonHub from './pages/PokemonHub.jsx';
import RarityHub from './pages/RarityHub.jsx';
import LanguageHub from './pages/LanguageHub.jsx';
import Guides from './pages/Guides.jsx';
import Products from './pages/Products.jsx';
import Auth from './pages/Auth.jsx';
import ExtensionAuthBridge from './pages/ExtensionAuthBridge.jsx';
import Profile from './pages/Profile.jsx';
import Seller from './pages/Seller.jsx';
import Cart from './pages/Cart.jsx';
import Wallet from './pages/Wallet.jsx';
import Forum from './pages/Forum.jsx';
import Signal from './pages/Signal.jsx';
import Scan from './pages/Scan.jsx';
import Inventory from './pages/Inventory.jsx';
import ScanDesk from './pages/ScanDesk.jsx';
import SellerHome from './pages/SellerHome.jsx';
import Buy from './pages/Buy.jsx';
import Admin from './pages/Admin.jsx';
import Checkout from './pages/Checkout.jsx';
import Orders from './pages/Orders.jsx';
import Collection from './pages/Collection.jsx';
import NftRedirect from './pages/Nft.jsx';
import Protection from './pages/Protection.jsx';
import EmailPreferences from './pages/EmailPreferences.jsx';
import Site from './pages/Site.jsx';
import About from './pages/About.jsx';
import WorkingOnIt from './components/WorkingOnIt.jsx';
import CookieBanner from './components/CookieBanner.jsx';
import { framedByChromeExtension } from './extension-auth-bridge.js';
import { isDashboardHost } from './scan-api.js';
import { MARKET_ORIGIN, isDashboardDeskPath } from './punchouts.js';
import { subscribeOriginDown } from './working-page.js';

function both(path, element) {
  return [
    <Route key={path} path={path} element={element} />,
    <Route key={`${path}/`} path={`${path}/`} element={element} />,
  ];
}

/** Leave dashboard.pokoin.com for the apex — do not paint marketplace routes here. */
function DashboardMarketHandoff({ target }) {
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return (
    <div className="page desk" style={{ padding: '2.5rem 1.25rem', color: 'var(--muted)' }} role="status">
      Opening marketplace…
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <WalletProvider>
        <CartProvider>
          <AppShell />
        </CartProvider>
      </WalletProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const { pathname, search } = useLocation();
  const [originDown, setOriginDown] = useState(() => (
    typeof window !== 'undefined' && Boolean(window.__pokoinOriginDown)
  ));
  useEffect(() => subscribeOriginDown(() => setOriginDown(true)), []);
  useEffect(() => {
    const on = framedByChromeExtension();
    document.documentElement.classList.toggle('is-extension-desk', on);
    return () => document.documentElement.classList.remove('is-extension-desk');
  }, []);
  const stripped = pathname.replace(/\/$/, '');
  const board = stripped === '/tests' || stripped === '/sanitize' || stripped === '/espurr' || stripped === '/ocr' || stripped === '/ocr/artists' || stripped === '/artwork' || stripped === '/extension/auth-bridge';
  const framed = framedByChromeExtension();
  // dashboard.pokoin.com/scan is the Scan Connect desk; pokoin.com/scan stays photo identify.
  const dashboard = isDashboardHost();
  // Never mount marketplace pages on the dashboard host — they paint black until refresh.
  if (dashboard && !framed && !board && !isDashboardDeskPath(pathname)) {
    return <DashboardMarketHandoff target={`${MARKET_ORIGIN}${pathname}${search || ''}`} />;
  }
  if (originDown && !board && !framed) {
    return <WorkingOnIt />;
  }
  const routes = (
    <Routes>
      {both('/tests', <TestsDashboard />)}
      {both('/sanitize', <Sanitize />)}
      {both('/espurr', <Espurr />)}
      {both('/ocr', <Ocr />)}
      {both('/ocr/artists', <OcrArtists />)}
      {both('/artwork', <ArtworkHover />)}
      {both('/marketplace', <Home />)}
      {both('/marketplace/search', <Search />)}
      {both('/marketplace/explore', <Explore />)}
      {both('/marketplace/portfolio', <Portfolio />)}
      {both('/marketplace/portfolio/:listingId', <Portfolio />)}
      {both('/marketplace/watchlist', <Watchlist />)}
      {both('/favorites', <Watchlist />)}
      {both('/nft', <NftRedirect />)}
      {both('/product', <Navigate to="/product/box" replace />)}
      {both('/product/:kind', <Products />)}
      {both('/marketplace/signal', <Signal />)}
      {both('/marketplace/competitive', <Competitive />)}
      {both('/marketplace/competitive/tournaments', <CompetitiveTournaments />)}
      {both('/marketplace/competitive/tournaments/:id', <CompetitiveTournaments />)}
      {both('/marketplace/competitive/decks', <CompetitiveDecks />)}
      {both('/marketplace/competitive/decks/:deckId', <CompetitiveDecks />)}
      {both('/marketplace/competitive/decklists/:decklistId', <CompetitiveDecklist />)}
      {both('/marketplace/competitive/players', <CompetitivePlayers />)}
      {both('/marketplace/competitive/players/:playerId', <CompetitivePlayers />)}
      {both('/marketplace/competitive/cards', <CompetitiveCards />)}
      {both('/marketplace/competitive/cards/:cardId', <CompetitiveCards />)}
      {both('/marketplace/sets', <Sets />)}
      {both('/marketplace/eras', <Era />)}
      {both('/marketplace/eras/:eraId', <Era />)}
      {both('/marketplace/sets/:slug', <Expansion />)}
      {both('/admin', <Admin />)}
      {both('/marketplace/admin', <Admin />)}
      {both('/marketplace/admin/edit', <Admin />)}
      {both('/marketplace/:lang/artists', <Artist />)}
      {both('/marketplace/:lang/artists/:artistSlug', <Artist />)}
      {both('/marketplace/:lang/users/:username', <Seller />)}
      {both('/marketplace/:lang/pokemon', <PokemonHub />)}
      {both('/marketplace/:lang/pokemon/:slug', <PokemonHub />)}
      {both('/marketplace/:lang/rarities', <RarityHub />)}
      {both('/marketplace/:lang/rarities/:slug', <RarityHub />)}
      {both('/marketplace/:lang/languages', <LanguageHub />)}
      {both('/marketplace/:lang/languages/:slug', <LanguageHub />)}
      {both('/marketplace/:lang/guides', <Guides />)}
      {both('/marketplace/:lang/guides/:slug', <Guides />)}
      {both('/marketplace/:lang/cards/:cardId/:slug/versions', <Versions />)}
      {both('/marketplace/:lang/cards/:cardId/versions', <Versions />)}
      {both('/marketplace/:lang/cards/:cardId/:slug?', <Card />)}
      {both('/auth', <Auth />)}
      {both('/extension/auth-bridge', <ExtensionAuthBridge />)}
      {both('/profile', <Profile />)}
      {both('/cart', <Cart />)}
      {both('/wallet', <Wallet />)}
      {both('/swap', <Navigate to="/wallet" replace />)}
      {both('/checkout', <Checkout />)}
      {both('/orders', <Orders />)}
      {both('/collection', <Collection />)}
      {both('/forum', <Forum />)}
      {both('/forum/category/:categoryId', <Forum />)}
      {both('/forum/topic/:topicId', <Forum />)}
      {both('/scan', dashboard ? <ScanDesk /> : <Scan />)}
      {both('/cardscan', <Scan />)}
      {both('/scancard', <Scan />)}
      {both('/inventory', <Inventory />)}
      {both('/inventory/scan', <ScanDesk />)}
      {both('/docs', <Site />)}
      {both('/about', <About />)}
      {both('/contact', <Site />)}
      {both('/privacy', <Site />)}
      {both('/email-preferences', <EmailPreferences />)}
      {both('/protection', <Protection />)}
      {both('/buy', <Buy />)}
      {both('/earn', <Site />)}
      {both('/whitepaper', <Site />)}
      {both('/health', <Site />)}
      {both('/', dashboard ? <SellerHome /> : <Navigate to="/marketplace" replace />)}
      {import.meta.env.DEV ? both('/dash-preview', <SellerHome />) : null}
      <Route path="*" element={<Navigate to={dashboard ? '/' : '/marketplace'} replace />} />
    </Routes>
  );
  if (board) {
    return routes;
  }
  return (
    <>
      <Chrome>{routes}</Chrome>
      <CookieBanner />
    </>
  );
}
