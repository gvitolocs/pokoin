import { useSelectBand } from '../select-band.jsx';

/**
 * Shop rows. Multi-select rubber-band is owned by SelectBandProvider (always
 * warm under Chrome). This list only paints selection onto its children.
 */
export default function ShopList({ className = '', children }) {
  const band = useSelectBand();
  const selected = band?.listingSelected || new Set();

  return (
    <div className={['shop-list', className].filter(Boolean).join(' ')}>
      {typeof children === 'function' ? children(selected) : children}
    </div>
  );
}
