/** Four-pointed star with concave sides, centred on (x, y) with tip radius r. */
function star(x, y, r) {
  const k = r * 0.26;
  return `M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}`
    + `Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`;
}

const SPARKLES = [star(9, 9, 7), star(17.6, 13.2, 4.6), star(11.4, 19.6, 3.2)].join('');

/** Three gold sparkles: the desk's reverse-holo toggle mark. */
export default function ReverseSparkles() {
  const id = `rv-gold-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <svg class="reverse-sparkles" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fff0a8" />
          <stop offset="0.45" stop-color="#ffd23d" />
          <stop offset="1" stop-color="#c98a00" />
        </linearGradient>
      </defs>
      <path d={SPARKLES} fill={`url(#${id})`} stroke="#8a5a00" stroke-width="0.35" stroke-linejoin="round" />
    </svg>
  );
}
