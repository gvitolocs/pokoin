import { useLayoutEffect } from 'react';
import { useSelectBand } from '../select-band.jsx';

/**
 * Shop rows. Multi-select rubber-band is owned by SelectBandProvider (always
 * warm under Chrome). Registers offers so desk + related + listings drag as one pile.
 */
export default function ShopList({
  className = '',
  children,
  offers = null,
  deskCard = null,
}) {
  const band = useSelectBand();
  const selected = band?.listingSelected || new Set();

  useLayoutEffect(() => {
    if (!band?.registerShop || !offers) return undefined;
    band.registerShop({ offers, deskCard });
    return () => band.unregisterShop?.();
  }, [band, offers, deskCard]);

  return (
    <div className={['shop-list', className].filter(Boolean).join(' ')}>
      {typeof children === 'function' ? children(selected) : children}
    </div>
  );
}
