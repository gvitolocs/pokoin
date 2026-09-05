import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import { CartProvider } from './cart.jsx';
import { WalletProvider } from './wallet.jsx';
import Chrome from './components/Chrome.jsx';
import Home from './pages/Home.jsx';
import Sanitize from './pages/Sanitize.jsx';
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
import Versions from './pages/Versions.jsx';
import Artist from './pages/Artist.jsx';
import Products from './pages/Products.jsx';
import Auth from './pages/Auth.jsx';
import Profile from './pages/Profile.jsx';
import Cart from './pages/Cart.jsx';
import Wallet from './pages/Wallet.jsx';
import Forum from './pages/Forum.jsx';
import Signal from './pages/Signal.jsx';
import Scan from './pages/Scan.jsx';
import Inventory from './pages/Inventory.jsx';
import Buy from './pages/Buy.jsx';
import Admin from './pages/Admin.jsx';
import Checkout from './pages/Checkout.jsx';
import Orders from './pages/Orders.jsx';
import Nft from './pages/Nft.jsx';
import Site from './pages/Site.jsx';

function both(path, element) {
  return [
    <Route key={path} path={path} element={element} />,
    <Route key={`${path}/`} path={`${path}/`} element={element} />,
  ];
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
  const { pathname } = useLocation();
  const board = pathname.replace(/\/$/, '') === '/sanitize';
  const routes = (
    <Routes>
      {both('/sanitize', <Sanitize />)}
      {both('/marketplace', <Home />)}
      {both('/marketplace/search', <Search />)}
      {both('/marketplace/explore', <Explore />)}
      {both('/marketplace/portfolio', <Portfolio />)}
      {both('/marketplace/portfolio/:listingId', <Portfolio />)}
      {both('/marketplace/watchlist', <Watchlist />)}
      {both('/favorites', <Watchlist />)}
      {both('/nft', <Nft />)}
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
      {both('/marketplace/sets/:slug', <Expansion />)}
      {both('/admin', <Admin />)}
      {both('/marketplace/admin', <Admin />)}
      {both('/marketplace/admin/edit', <Admin />)}
      {both('/marketplace/:lang/artists', <Artist />)}
      {both('/marketplace/:lang/artists/:artistSlug', <Artist />)}
      {both('/marketplace/:lang/cards/:cardId/:slug/versions', <Versions />)}
      {both('/marketplace/:lang/cards/:cardId/versions', <Versions />)}
      {both('/marketplace/:lang/cards/:cardId/:slug?', <Card />)}
      {both('/auth', <Auth />)}
      {both('/profile', <Profile />)}
      {both('/cart', <Cart />)}
      {both('/wallet', <Wallet />)}
      {both('/swap', <Navigate to="/wallet" replace />)}
      {both('/checkout', <Checkout />)}
      {both('/orders', <Orders />)}
      {both('/collection', <Navigate to="/nft" replace />)}
      {both('/forum', <Forum />)}
      {both('/forum/category/:categoryId', <Forum />)}
      {both('/forum/topic/:topicId', <Forum />)}
      {both('/scan', <Scan />)}
      {both('/cardscan', <Scan />)}
      {both('/scancard', <Scan />)}
      {both('/inventory', <Inventory />)}
      {both('/docs', <Site />)}
      {both('/about', <Site />)}
      {both('/contact', <Site />)}
      {both('/privacy', <Site />)}
      {both('/buy', <Buy />)}
      {both('/earn', <Site />)}
      {both('/whitepaper', <Site />)}
      {both('/health', <Site />)}
      <Route path="*" element={<Navigate to="/marketplace" replace />} />
    </Routes>
  );
  if (board) {
    return routes;
  }
  return <Chrome>{routes}</Chrome>;
}
