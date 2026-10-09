// React binding for the Desktop hold tray. desktop-hold.js itself stays
// framework-free so the Solid UI reads the same store.

import { useSyncExternalStore } from 'react';
import { emptyDesktopHold, readDesktopHold, subscribeDesktopHold } from './desktop-hold.js';

export function useDesktopHold() {
  return useSyncExternalStore(subscribeDesktopHold, readDesktopHold, emptyDesktopHold);
}
