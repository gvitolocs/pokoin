import { BUYSELL_ICON } from '@market/buysell-icon.js';

/** The two-arrows BuySell mark, sized to the text it sits in. */
export default function BuySellIcon() {
  return (
    <svg class="buysell-ico" viewBox="0 0 24 24" width="1.1em" height="1.1em" aria-hidden="true" focusable="false">
      <path fill="currentColor" d={BUYSELL_ICON} />
    </svg>
  );
}
