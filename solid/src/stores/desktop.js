import { readDesktopHold, subscribeDesktopHold } from '@market/desktop-hold.js';
import { fromExternalStore } from '../lib/external.js';

/**
 * Cards parked on the header Desktop tray (market/src/desktop-hold.js, the
 * same `pokoin.desktopHold` key the React UI uses). Writes go through the
 * shared module's addDesktopCards / setDesktopQty / removeDesktopCard.
 */
export const desktopItems = fromExternalStore(subscribeDesktopHold, readDesktopHold);
