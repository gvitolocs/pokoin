import { createSignal, onSettled } from 'solid-js';
import { fetchHomeRail } from '@market/api.js';
import { railTiles } from '@market/landing-rail.js';
import { currencyFromLocale } from '@market/pkn.js';
import Carousel from '../components/Carousel.jsx';
import { buyerCurrency } from '../stores/buyer.js';

/**
 * One marketplace home rail on the landing: the same Rust rail, Carousel and
 * CardTile as /marketplace, priced in the visitor's local currency.
 */
export default function LandingRail(props) {
  const [cards, setCards] = createSignal([]);
  const [pending, setPending] = createSignal(true);
  const currency = () => buyerCurrency() || currencyFromLocale();

  onSettled(() => {
    let live = true;
    fetchHomeRail(props.kind || 'bestSellers')
      .then((rail) => {
        if (!live) return;
        const tiles = railTiles(rail);
        setCards(tiles);
        if (!tiles.length) props.onEmpty?.();
      })
      .catch(() => {
        if (live) props.onEmpty?.();
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  });

  return (
    <Carousel
      title={props.title}
      cards={cards()}
      placeholders={pending() && !cards().length ? 8 : 0}
      eagerLimit={6}
      currency={currency()}
    />
  );
}
