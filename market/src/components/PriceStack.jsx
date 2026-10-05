/**
 * A buyer price with local currency: "3.23 DKK" in white on its own line
 * above "86 PKN", instead of one "3.23 DKK (86 PKN)" string that wraps the
 * Best Deal box and pushes shop rows apart. PKN-only prices render as-is;
 * unaffordable prices show the local line alone.
 */
export default function PriceStack({ parts, fallback = '—' }) {
  const local = parts?.local || '';
  const pkn = parts?.pkn || '';
  if (!local) return pkn || fallback;
  if (!pkn) return <span className="px-stack"><span className="px-local">{local}</span></span>;
  return (
    <span className="px-stack">
      <span className="px-local">{local}</span>
      <span className="px-pkn">{pkn}</span>
    </span>
  );
}
