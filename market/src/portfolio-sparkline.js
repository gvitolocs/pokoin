/** Polyline points for the header Dashboard preview's assets graph (260×88). No React. */
export function sparkline(days) {
  const values = days.map((day) => day.totalPkn);
  if (!values.length) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(max - min, 1);
  const width = 260;
  const height = 88;
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 6 - ((value - min) / span) * (height - 12);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}
