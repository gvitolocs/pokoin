import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { gameBasename } from './game.js';
import './styles.css';
import './desk.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter basename={gameBasename()}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
