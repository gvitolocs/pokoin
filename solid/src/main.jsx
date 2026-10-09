import { render } from '@solidjs/web';
import '@market/styles.css';
import '@market/desk.css';
import { Router } from './router.js';
import App from './App.jsx';

// Same numeric short-link handoff as the React entry (market/src/main.jsx).
const shortLink = window.location.pathname.match(/^\/(?:marketplace\/)?(\d+)(?:\/[^/]+)?$/);
if (shortLink) {
  window.location.replace(`/marketplace/en/cards/${shortLink[1]}`);
}

render(
  () => <Router>{(props) => <App>{props.children}</App>}</Router>,
  document.getElementById('root'),
);
