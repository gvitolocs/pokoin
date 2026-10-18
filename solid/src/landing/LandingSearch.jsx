import { onCleanup } from 'solid-js';
import { createRouter, useLocation } from '@solidjs/router';
import '@market/search-box.css';
import { game, setGamePathSource } from '@market/game.js';
import SearchBox from '../components/SearchBox.jsx';
import { landingHistory } from './landing-history.js';

/**
 * The hero search is the marketplace header's SearchBox: same game picker,
 * title-language and print-family pickers, popup, ranking and search URL.
 * Its router only tracks which game's marketplace home the box is on
 * (landing-history.js); links on the landing stay plain links.
 */
const Router = createRouter({
  routes: [{ path: '*any', component: () => null }],
  history: landingHistory(),
  explicitLinks: true,
});

function HeroSearch() {
  const location = useLocation();
  // game() and every catalog request follow the picked game, as in App.jsx.
  setGamePathSource(() => location.pathname);
  onCleanup(() => setGamePathSource(null));
  // A phone field is narrow beside the three pickers: name the game only.
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  return (
    <SearchBox
      hero
      inputId="hero-q"
      label={`Search ${game().name} cards`}
      placeholder={narrow ? `Search ${game().name}…` : `Search ${game().name} cards…`}
    />
  );
}

export default function LandingSearch() {
  return <Router>{() => <HeroSearch />}</Router>;
}
