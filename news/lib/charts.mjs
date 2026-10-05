// Deterministic inline SVG charts for the Pokoin News market module.
// Every plotted number comes only from chart.series; the sole computed values
// are axis ticks (niceTicks) and pixel coordinates.
import { esc } from './html.mjs';
import { formatPkn } from './format.mjs';

const MEASUREMENT_LABELS = Object.freeze({
  asking: 'Asking prices (listing asks)',
  inferred_sold: 'Inferred sold (CardTrader listing removals, not receipts)',
  count: 'Counts',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DASH_PATTERNS = ['', '7 4', '2 3'];
const MAX_SERIES = 3;

function round(value) {
  return Math.round(value * 100) / 100;
}

function niceNum(range, roundToNice) {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction;
  if (roundToNice) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * 10 ** exponent;
}

// Round, ascending axis ticks that cover [min, max].
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const target = Math.max(2, Math.min(8, Math.round(count) || 4));
  const step = niceNum(niceNum(hi - lo, false) / (target - 1), true);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let value = start; value <= end + step / 2; value += step) {
    const tick = step >= 1 ? Math.round(value) : Number(value.toFixed(6));
    if (!ticks.length || tick > ticks[ticks.length - 1]) ticks.push(tick);
  }
  return ticks;
}

function formatY(value, unit) {
  if (unit === 'PKN') return formatPkn(value);
  const digits = Number.isInteger(value) ? String(value) : String(round(value));
  return unit ? `${digits} ${unit}` : digits;
}

// "2026-09-11" -> "Sep 11"
function formatChartDate(x) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(x || ''));
  if (!match) return String(x || '');
  const month = MONTHS[Number(match[2]) - 1];
  return `${month || ''} ${Number(match[3])}`.trim();
}

function renderDataTable(chart, seriesList, xs, unit) {
  const bySeries = seriesList.map((series) => {
    const values = new Map();
    for (const point of series.points) {
      if (point && Number.isFinite(point.y)) values.set(point.x, point.y);
    }
    return values;
  });
  const head = `<tr><th scope="col">Date</th>${seriesList
    .map((series) => `<th scope="col">${esc(series.label)}</th>`)
    .join('')}</tr>`;
  const rows = xs
    .map((x) => {
      const cells = bySeries
        .map((values) => `<td>${values.has(x) ? esc(formatY(values.get(x), unit)) : '—'}</td>`)
        .join('');
      return `<tr><th scope="row">${esc(x)}</th>${cells}</tr>`;
    })
    .join('');
  return (
    `<details class="nx-chart__data"><summary>Data table</summary>` +
    `<table><caption>${esc(chart.title)}</caption><thead>${head}</thead><tbody>${rows}</tbody></table>` +
    `</details>`
  );
}

export function renderChart(chart, { width = 720, height = 280 } = {}) {
  if (!chart || typeof chart !== 'object') return '';
  const seriesList = (Array.isArray(chart.series) ? chart.series : [])
    .filter((series) => series && Array.isArray(series.points) && series.points.length)
    .slice(0, MAX_SERIES);
  if (!seriesList.length) return '';

  const xs = [];
  const xIndex = new Map();
  for (const series of seriesList) {
    for (const point of series.points) {
      if (!point || !Number.isFinite(point.y)) continue;
      if (!xIndex.has(point.x)) {
        xIndex.set(point.x, xs.length);
        xs.push(point.x);
      }
    }
  }
  if (xs.length < 2) return '';

  const values = [];
  for (const series of seriesList) {
    for (const point of series.points) if (point && Number.isFinite(point.y)) values.push(point.y);
  }
  if (values.length < 2) return '';

  const ticks = niceTicks(Math.min(...values), Math.max(...values), 4);
  if (ticks.length < 2) return '';
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const span = (y1 - y0) || 1;

  const padL = 64;
  const padR = 16;
  const padT = 16;
  const padB = 36;
  const plotW = Math.max(1, width - padL - padR);
  const plotH = Math.max(1, height - padT - padB);
  const n = xs.length;
  const xAt = (index) => padL + (index / (n - 1)) * plotW;
  const yAt = (value) => padT + (1 - (value - y0) / span) * plotH;
  const baseline = padT + plotH;

  const grid = ticks
    .map((tick) => {
      const y = round(yAt(tick));
      return (
        `<line class="nx-chart__grid" x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}"></line>` +
        `<text class="nx-chart__tick" x="${padL - 8}" y="${y + 4}" text-anchor="end">${esc(formatY(tick, chart.unit))}</text>`
      );
    })
    .join('');

  const labelIndices = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  const xLabels = labelIndices
    .map(
      (index) =>
        `<text class="nx-chart__xlabel" x="${round(xAt(index))}" y="${height - 10}" text-anchor="middle">${esc(formatChartDate(xs[index]))}</text>`,
    )
    .join('');

  const slot = plotW / n;
  const seriesMarkup = seriesList
    .map((series, seriesIndex) => {
      const className = `s${seriesIndex}`;
      const dash = DASH_PATTERNS[seriesIndex] ? ` stroke-dasharray="${DASH_PATTERNS[seriesIndex]}"` : '';
      const points = series.points
        .filter((point) => point && Number.isFinite(point.y) && xIndex.has(point.x))
        .map((point) => ({ xi: xIndex.get(point.x), x: xAt(xIndex.get(point.x)), y: yAt(point.y) }));

      if (chart.kind === 'bar') {
        const groupWidth = slot * 0.72;
        const barWidth = Math.max(2, groupWidth / seriesList.length);
        const offset = (slot - barWidth * seriesList.length) / 2;
        return points
          .map((point) => {
            const x = padL + point.xi * slot + offset + seriesIndex * barWidth;
            const y = round(point.y);
            return (
              `<rect class="nx-chart__bar ${className}" x="${round(x)}" y="${y}" width="${round(barWidth)}" ` +
              `height="${round(Math.max(0, baseline - point.y))}"${dash}></rect>`
            );
          })
          .join('');
      }

      const path = points.map((point, index) => `${index ? 'L' : 'M'}${round(point.x)},${round(point.y)}`).join(' ');
      const dots = points
        .map((point) => `<circle class="nx-chart__dot ${className}" cx="${round(point.x)}" cy="${round(point.y)}" r="2.5"></circle>`)
        .join('');
      return `<path class="nx-chart__line ${className}" d="${path}" fill="none"${dash}></path>${dots}`;
    })
    .join('');

  const legend =
    seriesList.length > 1
      ? `<ul class="nx-chart__legend">${seriesList
          .map(
            (series, seriesIndex) =>
              `<li class="s${seriesIndex}"><span class="nx-chart__key s${seriesIndex}"></span>${esc(series.label)}</li>`,
          )
          .join('')}</ul>`
      : '';

  const id = chart.id ? String(chart.id) : 'chart';
  const measurement = MEASUREMENT_LABELS[chart.measurement] || chart.measurement || '';
  const caption =
    `<figcaption class="nx-chart__caption"><strong>${esc(chart.title)}</strong> ` +
    `<span class="nx-chart__meta">Measurement: ${esc(measurement)} · Unit: ${esc(chart.unit)}</span></figcaption>`;

  return (
    `<figure class="nx-chart" data-measurement="${esc(chart.measurement)}" data-kind="${esc(chart.kind)}">` +
    `<svg class="nx-chart__svg" viewBox="0 0 ${width} ${height}" role="img" ` +
    `aria-labelledby="${esc(id)}-t ${esc(id)}-d" preserveAspectRatio="xMidYMid meet">` +
    `<title id="${esc(id)}-t">${esc(chart.title)}</title>` +
    `<desc id="${esc(id)}-d">${esc(chart.summary)}</desc>` +
    grid +
    xLabels +
    seriesMarkup +
    `</svg>` +
    legend +
    caption +
    renderDataTable(chart, seriesList, xs, chart.unit) +
    `</figure>`
  );
}
