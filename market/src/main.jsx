import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AppCrash } from './app-crash.jsx';
import { gameBasename } from './game.js';
import './styles.css';
import './desk.css';

const shortLink = window.location.pathname.match(/^\/(?:marketplace\/)?(\d+)(?:\/[^/]+)?$/);
if (shortLink) {
  window.location.replace(`/marketplace/en/cards/${shortLink[1]}`);
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter basename={gameBasename()}>
      <AppCrash>
        <App />
      </AppCrash>
    </BrowserRouter>
  </StrictMode>,
);
