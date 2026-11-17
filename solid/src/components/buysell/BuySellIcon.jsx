import { BUYSELL_BUY, BUYSELL_SELL } from '@market/buysell-icon.js';

/**
 * The two-tone BuySell mark: buy arrow gold, sell arrow blue, both from CSS variables
 * (--buysell-buy, --buysell-sell in styles.css). props.size is a CSS length or a number
 * of pixels; the default sits in a line of text.
 */
export default function BuySellIcon(props) {
  const size = () => props.size ?? '1.1em';
  return (
    <svg class={['buysell-ico', props.class]} viewBox="0 0 24 24" width={size()} height={size()} aria-hidden="true" focusable="false">
      <path class="bs-sell" d={BUYSELL_SELL} />
      <path class="bs-buy" d={BUYSELL_BUY} />
    </svg>
  );
}
