import { lazy } from 'solid-js';
import RedirectTo from '../pages/RedirectTo.jsx';

/**
 * Account, seller and onboarding pages (React URL map: market/src/App.jsx).
 * Every page is its own chunk. React registered each path with and without a
 * trailing slash; the Solid router matches both.
 */
const Stock = lazy(() => import('../pages/Stock.jsx'));
const Join = lazy(() => import('../pages/Join.jsx'));
const Invite = lazy(() => import('../pages/Invite.jsx'));
const AmbassadorProgram = lazy(() => import('../pages/AmbassadorProgram.jsx'));
const EmailPreferences = lazy(() => import('../pages/EmailPreferences.jsx'));
const ExtensionAuthBridge = lazy(() => import('../pages/ExtensionAuthBridge.jsx'));
const Auth = lazy(() => import('../pages/Auth.jsx'));
const CardTraderZero = lazy(() => import('../pages/CardTraderZero.jsx'));
const CardTraderOneDay = lazy(() => import('../pages/CardTraderOneDay.jsx'));
const Messages = lazy(() => import('../pages/Messages.jsx'));
const Conversation = lazy(() => import('../pages/Messages.jsx').then((m) => ({ default: m.Conversation })));
const Inventory = lazy(() => import('../pages/Inventory.jsx'));
const SellSpreadsheet = lazy(() => import('../pages/SellSpreadsheet.jsx'));

export default [
  { path: '/stock', component: Stock },
  { path: '/join/:code', component: Join },
  { path: '/invite', component: Invite },
  { path: '/ambassadorprogram', component: AmbassadorProgram },
  { path: '/email-preferences', component: EmailPreferences },
  { path: '/extension/auth-bridge', component: ExtensionAuthBridge },
  { path: '/auth', component: Auth },
  { path: '/mypokoin/zero', component: CardTraderZero },
  { path: '/mypokoin/1dr', component: CardTraderOneDay },
  { path: '/messages', component: Messages },
  { path: '/messages/:username', component: Conversation },
  { path: '/mypokoin/spreadsheet', component: SellSpreadsheet },
  { path: '/mypokoin/import', component: Inventory },
  { path: '/mypokoin/settings', component: Inventory },
  { path: '/mypokoin/collection', component: Inventory },
  { path: '/mypokoin/location/:location', component: Inventory },
  { path: '/mypokoin', component: Inventory },
  { path: '/inventory', component: RedirectTo, info: { to: '/mypokoin' } },
  { path: '/collection', component: RedirectTo, info: { to: '/mypokoin/collection' } },
  { path: '/ambassador', component: RedirectTo, info: { to: '/ambassadorprogram' } },
];
