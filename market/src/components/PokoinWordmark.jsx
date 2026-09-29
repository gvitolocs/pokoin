import mascotUrl from '../assets/pokoin-mascot@8x.png';

/**
 * The official Pokoin wordmark: heavy "P·koin" with the pixel coin mascot as
 * the first o and a coin dot on the i. Same markup as the topbar; the
 * standalone SVG is brand/logo/pokoin-logo.svg (scripts/build-brand-logo.py).
 */
export default function PokoinWordmark({ className = '' }) {
  return (
    <span className={`brand-word${className ? ` ${className}` : ''}`} aria-hidden="true">
      <span className="brand-letters">P</span>
      <img className="brand-coin" src={mascotUrl} alt="" width="26" height="24" />
      <span className="brand-letters">ko<span className="brand-i">ı</span>n</span>
    </span>
  );
}
