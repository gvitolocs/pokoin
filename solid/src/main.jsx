import { render } from '@solidjs/web';
import '@market/styles.css';
import '@market/desk.css';
import { Router } from './router.js';
import App from './App.jsx';
import { installYieldingLinks } from './lib/yield-nav.js';
import { installReactLegacyTripwire } from './lib/react-legacy.js';
import { installScanOrientation } from '@market/scan-orientation.js';
import { holdIfDeskPath } from '@market/hero-gate.js';

// A card desk load: its hero scan goes first; thumbnails, prefetches and idle
// extras wait for it (market/src/hero-gate.js).
holdIfDeskPath(window.location.pathname);

// Numeric short links (/806390, /marketplace/806390/slug) open the card.
const shortLink = window.location.pathname.match(/^\/(?:marketplace\/)?(\d+)(?:\/[^/]+)?$/);
if (shortLink) {
  window.location.replace(`/marketplace/en/cards/${shortLink[1]}`);
}

// Anything that would once have picked the React UI: App reports it as [react-legacy].
installReactLegacyTripwire();

// Before the router mounts, so it runs ahead of the router's own click listener.
installYieldingLinks();
// Before any card image loads: BREAK / LEGEND frames rotate portrait files only.
installScanOrientation();

render(
  () => <Router>{(props) => <App>{props.children}</App>}</Router>,
  document.getElementById('root'),
);
