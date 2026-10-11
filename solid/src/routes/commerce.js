import { lazy } from 'solid-js';
import RedirectTo from '../pages/RedirectTo.jsx';

/**
 * Buying and money pages (the React app's URLs). Every page is
 * its own chunk; React registered each path with and without a trailing
 * slash, and the Solid router matches both.
 */
const Cart = lazy(() => import('../pages/Cart.jsx'));
const Checkout = lazy(() => import('../pages/Checkout.jsx'));
const Orders = lazy(() => import('../pages/Orders.jsx'));
const Bought = lazy(() => import('../pages/Bought.jsx'));
const Buy = lazy(() => import('../pages/Buy.jsx'));
const Sales = lazy(() => import('../pages/Sales.jsx'));
const Wallet = lazy(() => import('../pages/Wallet.jsx'));
const Exchange = lazy(() => import('../pages/Exchange.jsx'));
const Flex = lazy(() => import('../pages/Flex.jsx'));
const Shipping = lazy(() => import('../pages/Shipping.jsx'));
const Protection = lazy(() => import('../pages/Protection.jsx'));
const Signal = lazy(() => import('../pages/Signal.jsx'));

export default [
  { path: '/cart', component: Cart },
  { path: '/checkout', component: Checkout },
  { path: '/orders', component: Orders },
  { path: '/bought', component: Bought },
  { path: '/buy', component: Buy },
  { path: '/sales', component: Sales },
  { path: '/wallet', component: Wallet },
  { path: '/exchange', component: Exchange },
  // React <Navigate replace>: /swap is the old Exchange URL.
  { path: '/swap', component: RedirectTo, info: { to: '/exchange' } },
  // Back-compat alias: NFT holdings live on the MyPokoin Collection tab.
  { path: '/nft', component: RedirectTo, info: { to: '/mypokoin/collection' } },
  { path: '/flex', component: Flex },
  { path: '/shipping', component: Shipping },
  { path: '/protection', component: Protection },
  { path: '/marketplace/signal', component: Signal },
];
