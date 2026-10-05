/**
 * A buyer price with local currency: "3.23 DKK" in white on its own line
 * above "86 PKN", instead of one "3.23 DKK (86 PKN)" string that wraps the
 * Best Deal box and pushes shop rows apart. PKN-only prices render as-is.
 * Unaffordable prices show the local amount alone, at the gold price size.
 */
export default function PriceStack({ parts, fallback = '—' }) {
  const local = parts?.local || '';
  const pkn = parts?.pkn || '';
  if (parts?.pending) return <span className="px-pending" aria-hidden="true" />;
  if (!local) return pkn || fallback;
  if (!pkn) return <span className="px-stack"><span className="px-local is-solo">{local}</span></span>;
  return (
    <span className="px-stack">
      <span className="px-local">{local}</span>
      <span className="px-pkn">{pkn}</span>
    </span>
  );
}
