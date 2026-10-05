// Body block renderers for the Pokoin News article contract.
// renderBlocks(record, ctx) walks record.blocks; unknown types render nothing.
import { esc, attr, safeUrl } from './html.mjs';
import { formatDate, formatDateTime, formatTime, formatPkn } from './format.mjs';
import { renderChart } from './charts.mjs';

const VERDICT_ICONS = Object.freeze({
  CONFIRMED: '✓',
  SUPPORTED: '✓',
  UNVERIFIED: '?',
  DISPUTED: '⇄',
  MISLEADING: '!',
  FALSE: '✕',
});

const MEASUREMENT_BADGES = Object.freeze({
  asking: 'Asking',
  inferred_sold: 'Inferred sold',
  count: 'Count',
});

const ANALYSIS_NOTE = "Analysis is Poko's interpretation of the evidence above. It adds no new facts.";

function refLinks(sourceIds, record) {
  const sources = Array.isArray(record && record.sources) ? record.sources : [];
  if (!Array.isArray(sourceIds)) return '';
  const index = new Map(sources.map((source, position) => [source && source.id, position + 1]));
  return sourceIds
    .filter((id) => index.has(id))
    .map((id) => `<a class="nx-ref" href="#src-${esc(id)}">[${index.get(id)}]</a>`)
    .join(' ');
}

function sourceRefs(sourceIds, record) {
  const links = refLinks(sourceIds, record);
  return links ? ` <sup class="nx-refs">${links}</sup>` : '';
}

function callout(modifier, label, text) {
  return (
    `<aside class="nx-callout ${modifier}"><p class="nx-callout__label">${label}</p>` +
    `<p>${esc(text)}</p></aside>`
  );
}

function renderListings(listings) {
  if (!listings || typeof listings !== 'object') return '';
  const segments = [];
  const count = Number.isFinite(listings.count) ? listings.count : null;
  const sellers = Number.isFinite(listings.sellerCount) ? listings.sellerCount : null;
  if (count !== null && sellers !== null) segments.push(`Listings tracked by Pokoin: ${count} from ${sellers} sellers`);
  else if (count !== null) segments.push(`Listings tracked by Pokoin: ${count}`);
  else if (sellers !== null) segments.push(`Listings tracked by Pokoin from ${sellers} sellers`);
  if (Number.isFinite(listings.lowestAskPkn)) {
    const ask = `Lowest ask ${formatPkn(listings.lowestAskPkn)}`;
    segments.push(listings.day ? `${ask} (${listings.day})` : ask);
  }
  if (!segments.length) return '';
  return `<p class="nx-inline-card__listings">${esc(segments.join(' · '))}</p>`;
}

function formatMetricValue(metric) {
  if (metric.unit === 'PKN') return formatPkn(metric.value);
  return `${metric.value} ${metric.unit}`;
}

// "Sep 4 – Oct 4, 2026" — the shared year is written once.
function formatWindow(from, to) {
  const fromDate = formatDate(from);
  const toDate = formatDate(to);
  if (!fromDate || !toDate) return `${fromDate} – ${toDate}`;
  const fromYear = fromDate.slice(-4);
  const toYear = toDate.slice(-4);
  const fromShort = fromYear === toYear ? fromDate.replace(/,\s*\d{4}$/, '') : fromDate;
  return `${fromShort} – ${toDate}`;
}

export function renderMarketModule(market, ctx = {}) {
  if (!market || market.sufficient !== true) return '';
  const subject = market.subject || {};
  const metrics = (Array.isArray(market.metrics) ? market.metrics : []).filter(
    (metric) => metric && Number.isFinite(metric.value),
  );
  const subjectName = esc(subject.name);
  const subjectTitle = subject.path
    ? `<a href="${esc(safeUrl(subject.path))}">${subjectName}</a>`
    : subjectName;

  const metricsHtml = metrics
    .map((metric) => {
      const badge = MEASUREMENT_BADGES[metric.measurement] || metric.measurement || '';
      return (
        `<div class="nx-market__metric" data-measurement="${esc(metric.measurement)}">` +
        `<dt>${esc(metric.label)}</dt>` +
        `<dd><span class="nx-market__value">${esc(formatMetricValue(metric))}</span> ` +
        `<span class="nx-market__badge">${esc(badge)}</span></dd>` +
        `<dd class="nx-market__definition"><small>${esc(metric.definition)}</small></dd>` +
        `</div>`
      );
    })
    .join('');

  const window = market.window
    ? `<p class="nx-market__window">Window: ${esc(formatWindow(market.window.from, market.window.to))} ` +
      `(${esc(market.window.days)} days)</p>`
    : '';
  const retrieved = market.retrievedAt
    ? `<p class="nx-market__retrieved">Retrieved: ${esc(formatDateTime(market.retrievedAt))}</p>`
    : '';
  const observations = Number.isInteger(market.observations)
    ? `<p class="nx-market__observations">Observations: ${market.observations}</p>`
    : '';
  const sourceNote = market.sourceNote
    ? `<p class="nx-market__source-note">${esc(market.sourceNote)}</p>`
    : '';

  return (
    `<section class="nx-market" aria-labelledby="nx-market-h">` +
    `<p class="nx-market__label">POKOIN MARKET DATA</p>` +
    `<h2 class="nx-market__title" id="nx-market-h">${subjectTitle}</h2>` +
    `<dl class="nx-market__metrics">${metricsHtml}</dl>` +
    window +
    `<p class="nx-market__currency">Currency: ${esc(market.currency)}</p>` +
    retrieved +
    observations +
    sourceNote +
    `</section>`
  );
}

export function renderBlock(block, record, ctx = {}) {
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'paragraph':
      return `<p>${esc(block.text)}${sourceRefs(block.sourceIds, record)}</p>`;
    case 'heading':
      return `<h2>${esc(block.text)}</h2>`;
    case 'list':
      return `<ul>${(block.items || []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
    case 'key_facts': {
      const title = block.title || 'What we know';
      const items = (block.items || [])
        .map((item) => `<li>${esc(item.text)}${sourceRefs(item.sourceIds, record)}</li>`)
        .join('');
      return (
        `<section class="nx-box nx-box--fact" aria-label="${esc(title)}">` +
        `<p class="nx-box__label">FACT</p>` +
        `<h2 class="nx-box__title">${esc(title)}</h2>` +
        `<ul class="nx-box__items">${items}</ul></section>`
      );
    }
    case 'unknowns': {
      const title = block.title || 'What remains unclear';
      const items = (block.items || []).map((item) => `<li>${esc(item.text)}</li>`).join('');
      return (
        `<section class="nx-box nx-box--unclear" aria-label="${esc(title)}">` +
        `<p class="nx-box__label">UNCLEAR</p>` +
        `<h2 class="nx-box__title">${esc(title)}</h2>` +
        `<ul class="nx-box__items">${items}</ul></section>`
      );
    }
    case 'fact_check': {
      const verdict = String(block.verdict || '');
      const icon = VERDICT_ICONS[verdict] || '?';
      const supported = Array.isArray(block.supportedBy) && block.supportedBy.length
        ? `<p class="nx-verdict__sources">Supported by ${refLinks(block.supportedBy, record)}</p>`
        : '';
      const contradicted = Array.isArray(block.contradictedBy) && block.contradictedBy.length
        ? `<p class="nx-verdict__sources">Contradicted by ${refLinks(block.contradictedBy, record)}</p>`
        : '';
      return (
        `<section class="nx-box nx-box--check nx-verdict--${esc(verdict.toLowerCase())}">` +
        `<p class="nx-box__label">FACT CHECK</p>` +
        `<blockquote class="nx-claim"><p>${esc(block.claim)}</p></blockquote>` +
        `<p class="nx-verdict"><span class="nx-verdict__icon" aria-hidden="true">${icon}</span> ` +
        `Verdict: <strong>${esc(verdict)}</strong></p>` +
        `<p class="nx-verdict__explanation">${esc(block.explanation)}</p>` +
        supported +
        contradicted +
        `</section>`
      );
    }
    case 'source_comparison': {
      const rows = (block.rows || [])
        .map((row) => {
          const says = (row.says || [])
            .map((say) => `<li>${esc(say.text)}${refLinks([say.sourceId], record)}</li>`)
            .join('');
          return `<tr><th scope="row">${esc(row.claim)}</th><td><ul>${says}</ul></td></tr>`;
        })
        .join('');
      return (
        `<table class="nx-table"><caption>How sources compare</caption>` +
        `<thead><tr><th scope="col">Claim</th><th scope="col">What sources say</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>`
      );
    }
    case 'why_it_matters':
      return callout('nx-callout--context', 'WHY IT MATTERS', block.text);
    case 'context':
      return callout('nx-callout--context', 'CONTEXT', block.text);
    case 'analysis':
      return (
        `<aside class="nx-callout nx-callout--analysis">` +
        `<p class="nx-callout__label">POKO ANALYSIS</p>` +
        `<p>${esc(block.text)}</p>` +
        `<p class="nx-callout__note">${ANALYSIS_NOTE}</p></aside>`
      );
    case 'market':
      return renderMarketModule(record.market, ctx);
    case 'chart': {
      const chart = ((record.market || {}).charts || []).find((entry) => entry && entry.id === block.chartId);
      return chart ? renderChart(chart, ctx) : '';
    }
    case 'gallery': {
      const byId = new Map((record.images || []).map((image) => [image && image.id, image]));
      const figures = (block.imageIds || [])
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((image) => {
          const tag = image.isIllustration ? '<span class="nx-gallery__tag">Illustration</span>' : '';
          const credit = image.credit ? ` <span class="nx-credit">${esc(image.credit)}</span>` : '';
          return (
            `<figure class="nx-gallery__item">${tag}` +
            `<img loading="lazy" decoding="async"${attr('width', image.width)}${attr('height', image.height)} ` +
            `src="${esc(safeUrl(image.url))}" alt="${esc(image.alt)}">` +
            `<figcaption>${esc(image.caption)}${credit}</figcaption></figure>`
          );
        })
        .join('');
      return figures ? `<section class="nx-gallery">${figures}</section>` : '';
    }
    case 'timeline': {
      const items = (block.items || [])
        .map(
          (item) =>
            `<li><time datetime="${esc(item.at)}">${esc(formatDateTime(item.at))}</time> ` +
            `<span>${esc(item.text)}</span>${sourceRefs(item.sourceIds, record)}</li>`,
        )
        .join('');
      return `<ol class="nx-timeline">${items}</ol>`;
    }
    case 'comparison': {
      const columns = (block.columns || []).map((column) =>
        typeof column === 'string' ? column : (column && column.name) || '',
      );
      const head = columns.map((column) => `<th scope="col">${esc(column)}</th>`).join('');
      const rows = (block.rows || [])
        .map(
          (row) =>
            `<tr><th scope="row">${esc(row.label)}</th>` +
            `${(row.values || []).map((value) => `<td>${esc(value)}</td>`).join('')}</tr>`,
        )
        .join('');
      return `<table class="nx-table"><thead><tr><th scope="col"></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    case 'faq': {
      const items = (block.items || [])
        .map((item) => `<dt>${esc(item.q)}</dt><dd>${esc(item.a)}</dd>`)
        .join('');
      return `<section class="nx-faq"><h2>FAQ</h2><dl>${items}</dl></section>`;
    }
    case 'related_card': {
      const card = ((record.related || {}).cards || []).find((entry) => entry && entry.cardId === block.cardId);
      if (!card) return '';
      const title = card.number ? `${esc(card.name)} — ${esc(card.number)}` : esc(card.name);
      const image = card.imageUrl
        ? `<img loading="lazy" decoding="async" src="${esc(safeUrl(card.imageUrl))}" alt="${esc(card.name)}">`
        : '';
      const setName = card.setName ? `<p class="nx-inline-card__set">${esc(card.setName)}</p>` : '';
      const link = card.path
        ? `<a class="nx-inline-card__link" href="${esc(safeUrl(card.path))}">View card</a>`
        : '';
      return (
        `<aside class="nx-inline-card">` +
        `<p class="nx-inline-card__label">RELATED CARD</p>${image}` +
        `<p class="nx-inline-card__name">${title}</p>${setName}` +
        renderListings(card.listings) +
        link +
        `</aside>`
      );
    }
    case 'related_set': {
      const set = ((record.related || {}).sets || []).find((entry) => entry && entry.slug === block.slug);
      if (!set) return '';
      const logoUrl = set.logoUrl || set.symbolUrl;
      const image = logoUrl
        ? `<img loading="lazy" decoding="async" src="${esc(safeUrl(logoUrl))}" alt="${esc(set.name)} logo">`
        : '';
      const count = Number.isFinite(set.cardCount)
        ? `<p class="nx-inline-set__count">${set.cardCount} cards</p>`
        : '';
      const link = set.path
        ? `<a class="nx-inline-set__link" href="${esc(safeUrl(set.path))}">Explore set</a>`
        : '';
      return (
        `<aside class="nx-inline-set">` +
        `<p class="nx-inline-set__label">RELATED SET</p>${image}` +
        `<p class="nx-inline-set__name">${esc(set.name)}</p>${count}${link}</aside>`
      );
    }
    case 'methodology':
      return (
        `<section class="nx-method"><p class="nx-method__label">METHODOLOGY</p>` +
        `<p>${esc(block.text)}</p></section>`
      );
    case 'quote': {
      const source = (record.sources || []).find((entry) => entry && entry.id === block.sourceId);
      const outlet = source ? esc(source.outlet) : '';
      return (
        `<blockquote class="nx-quote"><p>${esc(block.text)}</p>` +
        `<footer>— <cite>${outlet}</cite></footer></blockquote>`
      );
    }
    case 'update_note':
      return (
        `<p class="nx-update"><strong>Update — ${esc(formatTime(block.at))} UTC</strong> ` +
        `${esc(block.text)}</p>`
      );
    default:
      return '';
  }
}

export function renderBlocks(record, ctx = {}) {
  if (!record || !Array.isArray(record.blocks)) return '';
  return record.blocks.map((block) => renderBlock(block, record, ctx)).join('');
}
