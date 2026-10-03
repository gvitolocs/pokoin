import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import { CartProvider } from './cart.jsx';
import { WalletProvider } from './wallet.jsx';
import Chrome from './components/Chrome.jsx';
import Home from './pages/Home.jsx';
import CookieBanner from './components/CookieBanner.jsx';
import WorkingOnIt from './components/WorkingOnIt.jsx';
import { framedByChromeExtension } from './extension-auth-bridge.js';
import { isDashboardHost } from './scan-api.js';
import { legacyDashboardHref } from './punchouts.js';
import { subscribeOriginDown } from './working-page.js';

// Route-level code splitting: one chunk per page so the first marketplace
// paint does not download every desk, board, and admin surface (plus the
// Firestore SDK its pages pull in). Home stays eager — it is the SPA landing.
const Sanitize = lazy(() => import('./pages/Sanitize.jsx'));
const Espurr = lazy(() => import('./pages/Espurr.jsx'));
const Ocr = lazy(() => import('./pages/Ocr.jsx'));
const OcrArtists = lazy(() => import('./pages/OcrArtists.jsx'));
const ArtworkHover = lazy(() => import('./pages/ArtworkHover.jsx'));
const TestsDashboard = lazy(() => import('./pages/TestsDashboard.jsx'));
const JumbosBoard = lazy(() => import('./pages/JumbosBoard.jsx'));
const Search = lazy(() => import('./pages/Search.jsx'));
const Card = lazy(() => import('./pages/Card.jsx'));
const Expansion = lazy(() => import('./pages/Expansion.jsx'));
const Competitive = lazy(() => import('./pages/Competitive.jsx'));
const CompetitiveTournaments = lazy(() => import('./pages/CompetitiveTournaments.jsx'));
const CompetitiveDecks = lazy(() => import('./pages/CompetitiveDecks.jsx'));
const CompetitiveDecklist = lazy(() => import('./pages/CompetitiveDecklist.jsx'));
const CompetitivePlayers = lazy(() => import('./pages/CompetitivePlayers.jsx'));
const CompetitiveCards = lazy(() => import('./pages/CompetitiveCards.jsx'));
const Portfolio = lazy(() => import('./pages/Portfolio.jsx'));
const Explore = lazy(() => import('./pages/Explore.jsx'));
const Watchlist = lazy(() => import('./pages/Watchlist.jsx'));
const Sets = lazy(() => import('./pages/Sets.jsx'));
const Era = lazy(() => import('./pages/Era.jsx'));
const Versions = lazy(() => import('./pages/Versions.jsx'));
const Artist = lazy(() => import('./pages/Artist.jsx'));
const PokemonHub = lazy(() => import('./pages/PokemonHub.jsx'));
const RarityHub = lazy(() => import('./pages/RarityHub.jsx'));
const LanguageHub = lazy(() => import('./pages/LanguageHub.jsx'));
const Guides = lazy(() => import('./pages/Guides.jsx'));
const Products = lazy(() => import('./pages/Products.jsx'));
const Auth = lazy(() => import('./pages/Auth.jsx'));
const ExtensionAuthBridge = lazy(() => import('./pages/ExtensionAuthBridge.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const Seller = lazy(() => import('./pages/Seller.jsx'));
const Cart = lazy(() => import('./pages/Cart.jsx'));
const Wallet = lazy(() => import('./pages/Wallet.jsx'));
const Exchange = lazy(() => import('./pages/Exchange.jsx'));
const Messages = lazy(() => import('./pages/Messages.jsx'));
const Conversation = lazy(() => import('./pages/Messages.jsx').then((m) => ({ default: m.Conversation })));
const Forum = lazy(() => import('./pages/Forum.jsx'));
const Signal = lazy(() => import('./pages/Signal.jsx'));
const Scan = lazy(() => import('./pages/Scan.jsx'));
const Inventory = lazy(() => import('./pages/Inventory.jsx'));
const ScanDesk = lazy(() => import('./pages/ScanDesk.jsx'));
const SellerHome = lazy(() => import('./pages/SellerHome.jsx'));
const Buy = lazy(() => import('./pages/Buy.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const Checkout = lazy(() => import('./pages/Checkout.jsx'));
const Orders = lazy(() => import('./pages/Orders.jsx'));
const Associate = lazy(() => import('./pages/Associate.jsx'));
const Sales = lazy(() => import('./pages/Sales.jsx'));
const Bought = lazy(() => import('./pages/Bought.jsx'));
const Stock = lazy(() => import('./pages/Stock.jsx'));
const SyncReview = lazy(() => import('./pages/SyncReview.jsx'));
const CardTraderZero = lazy(() => import('./pages/CardTraderZero.jsx'));
const NftRedirect = lazy(() => import('./pages/Nft.jsx'));
const Protection = lazy(() => import('./pages/Protection.jsx'));
const Flex = lazy(() => import('./pages/Flex.jsx'));
const Shipping = lazy(() => import('./pages/Shipping.jsx'));
const Invite = lazy(() => import('./pages/Invite.jsx'));
const Join = lazy(() => import('./pages/Join.jsx'));
const AmbassadorProgram = lazy(() => import('./pages/AmbassadorProgram.jsx'));
const ReferralClaimer = lazy(() => import('./components/ReferralClaimer.jsx'));
const EmailPreferences = lazy(() => import('./pages/EmailPreferences.jsx'));
const Site = lazy(() => import('./pages/Site.jsx'));
const About = lazy(() => import('./pages/About.jsx'));
const SiteMap = lazy(() => import('./pages/SiteMap.jsx'));
const Careers = lazy(() => import('./pages/Careers.jsx'));
const ChatDock = lazy(() => import('./components/ChatDock.jsx'));

/** Route chunk placeholder — keeps the desk shell mounted, no CLS. */
function RouteSuspense({ children }) {
  return (
    <Suspense fallback={<div className="page desk" style={{ minHeight: '55vh' }} role="status" aria-busy="true" />}>
      {children}
    </Suspense>
  );
}

function both(path, element) {
  return [
    <Route key={path} path={path} element={element} />,
    <Route key={`${path}/`} path={`${path}/`} element={element} />,
  ];
}

/** Leave dashboard.pokoin.com for the same path on pokoin.com. */
function DashboardMarketHandoff({ target }) {
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return (
    <div className="page desk" style={{ padding: '2.5rem 1.25rem', color: 'var(--muted)' }} role="status">
      Opening Pokoin…
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
  const board = stripped === '/tests' || stripped === '/sanitize' || stripped === '/espurr' || stripped === '/ocr' || stripped === '/ocr/artists' || stripped === '/artwork' || stripped === '/jumbos' || stripped === '/extension/auth-bridge';
  const framed = framedByChromeExtension();
  // pokoin.com/scan stays the public photo page. Scan Connect is /dashboard/scan.
  // The legacy host never paints the SPA: / and /scan move under /dashboard.
  if (isDashboardHost() && !board) {
    return <DashboardMarketHandoff target={legacyDashboardHref(pathname, search)} />;
  }
  if (originDown && !board && !framed) {
    return <WorkingOnIt />;
  }
  const routes = (
    <RouteSuspense>
      <Routes>
      {both('/tests', <TestsDashboard />)}
      {both('/sanitize', <Sanitize />)}
      {both('/espurr', <Espurr />)}
      {both('/ocr', <Ocr />)}
      {both('/ocr/artists', <OcrArtists />)}
      {both('/artwork', <ArtworkHover />)}
      {both('/jumbos', <JumbosBoard />)}
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
      {both('/exchange', <Exchange />)}
      {both('/messages', <Messages />)}
      {both('/messages/:username', <Conversation />)}
      {both('/swap', <Navigate to="/exchange" replace />)}
      {both('/checkout', <Checkout />)}
      {both('/orders', <Orders />)}
      {both('/associate', <Associate />)}
      {both('/sales', <Sales />)}
      {both('/bought', <Bought />)}
      {both('/stock', <Stock />)}
      {both('/inventory/sync-review', <SyncReview />)}
      {both('/collection', <Navigate to="/mypokoin/collection" replace />)}
      {both('/forum', <Forum />)}
      {both('/forum/category/:categoryId', <Forum />)}
      {both('/forum/topic/:topicId', <Forum />)}
      {both('/scan', <Scan />)}
      {both('/cardscan', <Scan />)}
      {both('/scancard', <Scan />)}
      {both('/dashboard/scan', <ScanDesk />)}
      {both('/mypokoin/import', <Inventory />)}
      {both('/mypokoin/location/:location', <Inventory />)}
      {both('/mypokoin/settings', <Inventory />)}
      {both('/mypokoin/collection', <Inventory />)}
      {both('/mypokoin/zero', <CardTraderZero />)}
      {both('/mypokoin', <Inventory />)}
      {both('/inventory', <Navigate to="/mypokoin" replace />)}
      {both('/inventory/scan', <ScanDesk />)}
      {both('/docs', <Site />)}
      {both('/about', <About />)}
      {both('/sitemap', <SiteMap />)}
      {both('/careers', <Careers />)}
      {both('/contact', <Site />)}
      {both('/privacy', <Site />)}
      {both('/email-preferences', <EmailPreferences />)}
      {both('/protection', <Protection />)}
      {both('/flex', <Flex />)}
      {both('/shipping', <Shipping />)}
      {both('/invite', <Invite />)}
      {both('/join/:code', <Join />)}
      {both('/ambassadorprogram', <AmbassadorProgram />)}
      {both('/ambassador', <Navigate to="/ambassadorprogram" replace />)}
      {both('/buy', <Buy />)}
      {both('/earn', <Site />)}
      {both('/whitepaper', <Site />)}
      {both('/health', <Site />)}
      {both('/dashboard', <SellerHome />)}
      {both('/', <Navigate to="/marketplace" replace />)}
      {import.meta.env.DEV ? both('/dash-preview', <SellerHome />) : null}
      <Route path="*" element={<Navigate to="/marketplace" replace />} />
      </Routes>
    </RouteSuspense>
  );
  if (board) {
    return routes;
  }
  return (
    <>
      <Chrome>{routes}</Chrome>
      <ReferralClaimer />
      <CookieBanner />
      <Suspense fallback={null}>
        <ChatDock />
      </Suspense>
    </>
  );
}
