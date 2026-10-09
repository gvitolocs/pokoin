import { render } from '@solidjs/web';
import '@market/styles.css';
import '@market/desk.css';
import { Router } from './router.js';
import App from './App.jsx';
import { installYieldingLinks } from './lib/yield-nav.js';

// Same numeric short-link handoff as the React entry (market/src/main.jsx).
const shortLink = window.location.pathname.match(/^\/(?:marketplace\/)?(\d+)(?:\/[^/]+)?$/);
if (shortLink) {
  window.location.replace(`/marketplace/en/cards/${shortLink[1]}`);
}

// Before the router mounts, so it runs ahead of the router's own click listener.
installYieldingLinks();

render(
  () => <Router>{(props) => <App>{props.children}</App>}</Router>,
  document.getElementById('root'),
);
