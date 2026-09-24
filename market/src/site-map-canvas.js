/**
 * pokoin.com/sitemap renderer: one 2D canvas, a pan/zoom camera, and a
 * spatial grid for hover/click. Imperative on purpose — React only owns the
 * panel and overlays around it.
 */
import { MAX_LINES, PRICE_BUCKETS, neighbors, nodeInfo, position, priceBucket, sameRef } from './site-map-graph.js';

const CELL = 6;
const TAU = Math.PI * 2;
const MIN_K = 0.05;
const MAX_K = 260;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

function hexToRgb(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function buildGrid(model) {
  const { data } = model;
  const cells = new Map();
  const add = (kind, i, x, y) => {
    const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(kind, i);
  };
  for (let i = 0; i < model.count; i += 1) add('card', i, model.cx[i], model.cy[i]);
  data.species.forEach((row, i) => add('species', i, row.x, row.y));
  data.artists.forEach((row, i) => add('artist', i, row.x, row.y));
  data.pages.forEach((row, i) => add('page', i, row.x, row.y));
  return cells;
}

/** Radii in world units, from how many card desks a hub links to. */
function hubRadius(n) {
  return 0.9 + Math.sqrt(n) * 0.12;
}

export function createSiteMapCanvas(canvas, model, { onHover, onSelect, readColors }) {
  const ctx = canvas.getContext('2d');
  const { data } = model;
  const grid = buildGrid(model);
  const cam = { x: 0, y: 0, k: 1 };
  let W = 0;
  let H = 0;
  let dpr = 1;
  let fitted = false;
  let raf = 0;
  let anim = null;
  let selected = null;
  let focus = null;
  let hovered = null;
  let hidden = new Set();
  let colors = readColors();
  let rgb = {};
  let labelHits = [];
  const pointers = new Map();
  let gesture = null;
  let pendingFly = null;
  let mode = 'structure';
  let onlyListed = false;
  let path = null;
  // Market colour step per desk (-1 = no listing), and the desks per step for full-frame draws.
  const bucket = new Int8Array(model.count);
  const bucketLists = Array.from({ length: PRICE_BUCKETS + 1 }, () => []);
  for (let i = 0; i < model.count; i += 1) {
    bucket[i] = priceBucket(model, i);
    bucketLists[bucket[i] + 1].push(i);
  }
  // Screen space covered by the details panel; fly targets centre in what is left.
  let inset = { top: 0, right: 0, bottom: 0 };

  function refreshColors() {
    colors = readColors();
    rgb = Object.fromEntries(Object.entries(colors).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, hexToRgb(v)]));
  }
  refreshColors();

  const toScreenX = (x) => (x - cam.x) * cam.k + W / 2;
  const toScreenY = (y) => (y - cam.y) * cam.k + H / 2;
  const toWorld = (sx, sy) => [(sx - W / 2) / cam.k + cam.x, (sy - H / 2) / cam.k + cam.y];

  function fitK() {
    return Math.min(W, H) / (2 * model.extent);
  }

  function request() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    if (anim) {
      const t = clamp((now - anim.start) / anim.ms, 0, 1);
      const e = ease(t);
      cam.x = anim.from.x + (anim.to.x - anim.from.x) * e;
      cam.y = anim.from.y + (anim.to.y - anim.from.y) * e;
      cam.k = Math.exp(Math.log(anim.from.k) + (Math.log(anim.to.k) - Math.log(anim.from.k)) * e);
      if (t < 1) request();
      else anim = null;
    }
    draw();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const wasFit = !fitted || Math.abs(cam.k - fitK()) < 1e-6;
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (wasFit) {
      cam.x = 0;
      cam.y = 0;
      cam.k = fitK();
      fitted = true;
    }
    if (pendingFly) {
      const { ref, opts } = pendingFly;
      pendingFly = null;
      flyTo(ref, opts);
    }
    request();
  }

  // Measure now and on window resize too: ResizeObserver alone can stay silent
  // (background tabs, emulated viewports) and leave the canvas at 300×150.
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  window.addEventListener('resize', resize);
  resize();

  /* ------------------------------------------------------------ drawing */

  function inView(x, y, pad) {
    const sx = toScreenX(x);
    const sy = toScreenY(y);
    return sx > -pad && sx < W + pad && sy > -pad && sy < H + pad;
  }

  function dot(x, y, r) {
    const sx = toScreenX(x);
    const sy = toScreenY(y);
    ctx.moveTo(sx + r, sy);
    ctx.arc(sx, sy, r, 0, TAU);
  }

  function drawCards(only) {
    const k = cam.k;
    const size = clamp(k * 0.62, 0.9, 12);
    const [x0, y0] = toWorld(-size, -size);
    const [x1, y1] = toWorld(W + size, H + size);
    const round = size >= 2.4;
    const list = only || null;
    const n = list ? list.length : model.count;
    ctx.beginPath();
    for (let j = 0; j < n; j += 1) {
      const i = list ? list[j] : j;
      const x = model.cx[i];
      const y = model.cy[i];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (round) dot(x, y, size / 2);
      else ctx.rect(toScreenX(x) - size / 2, toScreenY(y) - size / 2, size, size);
    }
    ctx.fill();
  }

  /** Structure: one starlight colour. Market: unlisted desks dim, listed desks on the price ramp. */
  function paintCards(list, lit = false) {
    if (mode !== 'market') {
      ctx.fillStyle = lit ? colors.text : `rgb(${rgb.card} / ${clamp(0.35 + cam.k * 0.5, 0.35, 0.95)})`;
      drawCards(list);
      return;
    }
    let groups = bucketLists;
    if (list) {
      groups = Array.from({ length: PRICE_BUCKETS + 1 }, () => []);
      for (const i of list) groups[bucket[i] + 1].push(i);
    }
    if (!onlyListed) {
      ctx.fillStyle = `rgb(${rgb.muted} / ${lit ? 0.7 : 0.16})`;
      drawCards(groups[0]);
    }
    for (let b = 0; b < PRICE_BUCKETS; b += 1) {
      ctx.fillStyle = colors.ramp[b];
      drawCards(groups[b + 1]);
    }
  }

  function drawPath() {
    if (!path || path.length < 2) return;
    const pts = path.map((ref) => position(model, ref));
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colors.yellow;
    ctx.beginPath();
    pts.forEach(([x, y], n) => {
      if (n) ctx.lineTo(toScreenX(x), toScreenY(y));
      else ctx.moveTo(toScreenX(x), toScreenY(y));
    });
    ctx.stroke();
    const taken = [];
    path.forEach((ref, n) => {
      const sx = toScreenX(pts[n][0]);
      const sy = toScreenY(pts[n][1]);
      ctx.fillStyle = colors[ref.kind === 'card' ? 'text' : ref.kind === 'era' ? 'yellow' : ref.kind] || colors.text;
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, TAU);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = colors.bg;
      ctx.stroke();
      ctx.font = FONT(9, 800);
      ctx.fillStyle = colors.bg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n + 1), sx, sy + 0.5);
      const info = nodeInfo(model, ref);
      const below = n % 2 === 1;
      placeLabel(info.label, sx, below ? sy + 11 : sy - 11, { size: 12, weight: 700, baseline: below ? 'top' : 'bottom', ref, taken });
    });
  }

  function drawRings() {
    const { radii } = data;
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgb(${rgb.muted} / 0.18)`;
    for (const r of [radii.species, radii.artists]) {
      ctx.beginPath();
      ctx.arc(toScreenX(0), toScreenY(0), r * cam.k, 0, TAU);
      ctx.stroke();
    }
  }

  function drawSetDiscs(alphaScale = 1) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgb(${rgb.set} / ${0.5 * alphaScale})`;
    ctx.beginPath();
    data.sets.forEach((set, s) => {
      const r = model.setR[s] * cam.k;
      if (r < 2.5 || !inView(set.x, set.y, r)) return;
      const sx = toScreenX(set.x);
      const sy = toScreenY(set.y);
      ctx.moveTo(sx + r, sy);
      ctx.arc(sx, sy, r, 0, TAU);
    });
    ctx.stroke();
  }

  function drawPageLinks() {
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgb(${rgb.page} / 0.16)`;
    ctx.beginPath();
    for (const [a, b] of data.pageLinks) {
      if (a === model.shell || b === model.shell) continue;
      const pa = data.pages[a];
      const pb = data.pages[b];
      ctx.moveTo(toScreenX(pa.x), toScreenY(pa.y));
      ctx.lineTo(toScreenX(pb.x), toScreenY(pb.y));
    }
    ctx.stroke();
  }

  function drawHubs(kind, rows, color, only) {
    const minR = kind === 'page' ? 3 : 1.4;
    ctx.fillStyle = color;
    ctx.beginPath();
    const list = only || rows.map((_, i) => i);
    for (const i of list) {
      const row = rows[i];
      const r = kind === 'page' ? Math.max(minR, 1.6 * cam.k) : Math.max(minR, hubRadius(row.n) * cam.k);
      if (!inView(row.x, row.y, r)) continue;
      dot(row.x, row.y, r);
    }
    ctx.fill();
  }

  const FONT = (size, weight = 600) => `${weight} ${size}px ${colors.font}`;

  function placeLabel(text, sx, sy, { size = 12, weight = 600, color = colors.text, align = 'center', baseline = 'middle', ref = null, taken, pad = 3, halo = true }) {
    ctx.font = FONT(size, weight);
    const w = ctx.measureText(text).width;
    let left = sx;
    if (align === 'center') left = sx - w / 2;
    else if (align === 'right') left = sx - w;
    let top = sy - size / 2;
    if (baseline === 'bottom') top = sy - size;
    else if (baseline === 'top') top = sy;
    const box = [left - pad, top - pad, left + w + pad, top + size + pad];
    if (box[2] < 0 || box[0] > W || box[3] < 0 || box[1] > H) return false;
    if (taken) {
      for (const b of taken) {
        if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) return false;
      }
      taken.push(box);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    if (halo) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.bg;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, left, top);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, left, top);
    if (ref) labelHits.push({ box, ref });
    return true;
  }

  /** Radial labels for the Pokédex / artist rings, most-linked first, never stacked. */
  function ringLabels(kind, rows, taken, allow, inward = false) {
    const size = 11;
    const accepted = [];
    const order = rows.map((row, i) => i).filter((i) => !allow || allow.has(i)).sort((a, b) => rows[b].n - rows[a].n);
    let budget = 260;
    for (const i of order) {
      if (budget <= 0) break;
      const row = rows[i];
      const radius = Math.hypot(row.x, row.y);
      const minGap = (size + 2) / (radius * cam.k);
      const angle = Math.atan2(row.y, row.x);
      if (accepted.some((a) => Math.abs(((angle - a + Math.PI * 3) % TAU) - Math.PI) < minGap)) continue;
      const sx = toScreenX(row.x);
      const sy = toScreenY(row.y);
      if (sx < -80 || sx > W + 80 || sy < -80 || sy > H + 80) continue;
      accepted.push(angle);
      budget -= 1;
      // Pokédex labels read inward, artist labels outward: the two rings never share a gap.
      const along = inward ? angle + Math.PI : angle;
      const upside = Math.cos(along) < 0;
      const gap = Math.max(hubRadius(row.n) * cam.k, 1.5) + 4;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(upside ? along + Math.PI : along);
      ctx.font = FONT(size, 500);
      ctx.textBaseline = 'middle';
      ctx.textAlign = upside ? 'right' : 'left';
      ctx.fillStyle = colors.muted;
      ctx.fillText(row.name, upside ? -gap : gap, 0);
      const w = ctx.measureText(row.name).width;
      ctx.restore();
      // Hit box along the radial direction, approximated by its screen-space bounds.
      const ex = sx + Math.cos(along) * (gap + w);
      const ey = sy + Math.sin(along) * (gap + w);
      labelHits.push({ box: [Math.min(sx, ex) - 4, Math.min(sy, ey) - 6, Math.max(sx, ex) + 4, Math.max(sy, ey) + 6], ref: { kind, i } });
    }
    return taken;
  }

  function drawLabels(highlight) {
    const taken = [];
    const k = cam.k;
    // Pages first: the core is what most people come here for.
    if (!hidden.has('page')) {
      const pageOrder = data.pages.map((_, i) => i).sort((a, b) => model.pageIn[b].length - model.pageIn[a].length);
      for (const i of pageOrder) {
        if (highlight && !highlight.page.has(i)) continue;
        const page = data.pages[i];
        const r = Math.max(3, 1.6 * k);
        placeLabel(page.label, toScreenX(page.x), toScreenY(page.y) - r - 2, { size: 11, baseline: 'bottom', ref: { kind: 'page', i }, taken, color: colors.text });
      }
    }
    // Eras above their clusters; fade once a single era fills the screen.
    const eraAlpha = clamp(1.6 - (k * 180) / Math.min(W, H), 0, 1);
    if (eraAlpha > 0.05) {
      data.eras.forEach((era, e) => {
        if (!model.setsOnEra[e].length && !data.sets.some((set) => set.era === e)) return;
        if (highlight && !highlight.era.has(e)) return;
        const size = clamp(era.r * k * 0.16, 12, 22);
        ctx.globalAlpha = eraAlpha;
        placeLabel(era.name.toUpperCase(), toScreenX(era.x), toScreenY(era.y - era.r) - 6, { size, weight: 700, color: colors.yellow, baseline: 'bottom', ref: { kind: 'era', i: e }, taken });
        ctx.globalAlpha = 1;
      });
    }
    if (!hidden.has('set')) {
      const order = data.sets.map((_, i) => i).sort((a, b) => data.sets[b].n - data.sets[a].n);
      for (const s of order) {
        if (highlight && !highlight.set.has(s)) continue;
        const set = data.sets[s];
        const r = model.setR[s] * k;
        if (r < 14 && !(highlight && highlight.set.size < 60)) continue;
        const deep = r > Math.min(W, H) * 0.25;
        const y = deep ? toScreenY(set.y - model.setR[s]) - 4 : toScreenY(set.y);
        placeLabel(set.name, toScreenX(set.x), y, { size: deep ? 15 : 12, weight: 600, baseline: deep ? 'bottom' : 'middle', ref: { kind: 'set', i: s }, taken });
      }
    }
    // Card names once a star has room for one.
    if (!hidden.has('card') && k >= 14) {
      const [x0, y0] = toWorld(0, 0);
      const [x1, y1] = toWorld(W, H);
      let budget = 400;
      for (let i = 0; i < model.count && budget > 0; i += 1) {
        const x = model.cx[i];
        const y = model.cy[i];
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        if (highlight && !highlight.card.has(i)) continue;
        const name = data.names[data.cards.name[i]];
        if (placeLabel(name, toScreenX(x), toScreenY(y) + clamp(k * 0.31, 1, 6) + 2, { size: 10, weight: 500, color: colors.muted, baseline: 'top', ref: { kind: 'card', i }, taken })) {
          budget -= 1;
        }
      }
    }
    if (!hidden.has('species')) ringLabels('species', data.species, taken, highlight?.species, true);
    if (!hidden.has('artist')) ringLabels('artist', data.artists, taken, highlight?.artist);
  }

  function draw() {
    if (!W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);
    labelHits = [];
    const dim = focus || path ? 0.28 : 1;

    ctx.globalAlpha = dim;
    drawRings();
    if (!hidden.has('page')) drawPageLinks();
    if (!hidden.has('set')) drawSetDiscs();
    if (!hidden.has('card')) paintCards(null);
    if (!hidden.has('species')) drawHubs('species', data.species, colors.species);
    if (!hidden.has('artist')) drawHubs('artist', data.artists, colors.artist);
    if (!hidden.has('page')) drawHubs('page', data.pages, colors.page);
    ctx.globalAlpha = 1;

    if (path) {
      ctx.fillStyle = `rgb(${rgb.bg} / 0.55)`;
      ctx.fillRect(0, 0, W, H);
      drawPath();
    } else if (focus) {
      ctx.fillStyle = `rgb(${rgb.bg} / 0.55)`;
      ctx.fillRect(0, 0, W, H);
      const [fx, fy] = focus.origin;
      const ox = toScreenX(fx);
      const oy = toScreenY(fy);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgb(${rgb.yellow} / ${focus.lines.length / 2 > 800 ? 0.16 : 0.42})`;
      ctx.beginPath();
      for (let j = 0; j < focus.lines.length; j += 2) {
        ctx.moveTo(ox, oy);
        ctx.lineTo(toScreenX(focus.lines[j]), toScreenY(focus.lines[j + 1]));
      }
      ctx.stroke();
      if (focus.set.size) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = colors.set;
        ctx.beginPath();
        for (const s of focus.set) {
          const set = data.sets[s];
          const r = Math.max(model.setR[s] * cam.k, 3);
          ctx.moveTo(toScreenX(set.x) + r, toScreenY(set.y));
          ctx.arc(toScreenX(set.x), toScreenY(set.y), r, 0, TAU);
        }
        ctx.stroke();
      }
      if (focus.era.size) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = `rgb(${rgb.yellow} / 0.7)`;
        ctx.beginPath();
        for (const e of focus.era) {
          const era = data.eras[e];
          ctx.moveTo(toScreenX(era.x) + era.r * cam.k, toScreenY(era.y));
          ctx.arc(toScreenX(era.x), toScreenY(era.y), era.r * cam.k, 0, TAU);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (focus.card.size) paintCards([...focus.card], true);
      if (focus.species.size) drawHubs('species', data.species, colors.species, [...focus.species]);
      if (focus.artist.size) drawHubs('artist', data.artists, colors.artist, [...focus.artist]);
      if (focus.page.size) drawHubs('page', data.pages, colors.page, [...focus.page]);
      drawLabels(focus);
    } else {
      drawLabels(null);
    }

    const ring = hovered || null;
    for (const ref of [selected, ring]) {
      if (!ref) continue;
      const [x, y] = position(model, ref);
      let r = 7;
      if (ref.kind === 'set') r = Math.max(model.setR[ref.i] * cam.k, 6) + 2;
      else if (ref.kind === 'era') r = data.eras[ref.i].r * cam.k + 3;
      else if (ref.kind === 'card') r = Math.max(cam.k * 0.5, 4) + 2;
      ctx.lineWidth = sameRef(ref, selected) ? 2 : 1.25;
      ctx.strokeStyle = sameRef(ref, selected) ? colors.yellow : colors.text;
      ctx.beginPath();
      ctx.arc(toScreenX(x), toScreenY(y), r, 0, TAU);
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------ focus */

  function computeFocus(ref) {
    if (!ref) return null;
    const { out, into, instances } = neighbors(model, ref);
    const f = { origin: position(model, ref), page: new Set(), set: new Set(), era: new Set(), card: new Set(), species: new Set(), artist: new Set(), lines: [] };
    const all = [...out, ...into].flatMap((group) => group.refs);
    if (instances && instances.kind !== 'card') all.push(...instances.refs);
    const seen = new Set();
    for (const r of all) {
      const key = `${r.kind}:${r.i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      f[r.kind].add(r.i);
      // Cards of the selected set are inside its disc: no spokes, just lit stars.
      if (ref.kind === 'set' && r.kind === 'card') continue;
      if (f.lines.length / 2 < MAX_LINES) {
        const [x, y] = position(model, r);
        f.lines.push(x, y);
      }
    }
    f[ref.kind].add(ref.i);
    if (ref.kind === 'era') {
      f.era.add(ref.i);
    }
    return f;
  }

  /* ------------------------------------------------------------ hit test */

  function hitTest(sx, sy) {
    for (let j = labelHits.length - 1; j >= 0; j -= 1) {
      const { box, ref } = labelHits[j];
      if (sx >= box[0] && sx <= box[2] && sy >= box[1] && sy <= box[3] && !hidden.has(ref.kind)) return ref;
    }
    const [wx, wy] = toWorld(sx, sy);
    const reach = Math.max(8 / cam.k, 0.6);
    const c0 = Math.floor((wx - reach) / CELL);
    const c1 = Math.floor((wx + reach) / CELL);
    const r0 = Math.floor((wy - reach) / CELL);
    const r1 = Math.floor((wy + reach) / CELL);
    let best = null;
    let bestD = Infinity;
    for (let c = c0; c <= c1; c += 1) {
      for (let r = r0; r <= r1; r += 1) {
        const list = grid.get(`${c},${r}`);
        if (!list) continue;
        for (let j = 0; j < list.length; j += 2) {
          const kind = list[j];
          if (hidden.has(kind)) continue;
          const i = list[j + 1];
          if (kind === 'card' && mode === 'market' && onlyListed && bucket[i] < 0) continue;
          const [x, y] = position(model, { kind, i });
          let d = Math.hypot(x - wx, y - wy) * cam.k;
          if (kind !== 'card') d -= 4; // hubs win ties with the stars under them
          if (d < bestD) {
            bestD = d;
            best = { kind, i };
          }
        }
      }
    }
    if (best && bestD <= 9) return best;
    if (!hidden.has('set')) {
      for (let s = 0; s < data.sets.length; s += 1) {
        const set = data.sets[s];
        if (Math.hypot(set.x - wx, set.y - wy) <= model.setR[s]) return { kind: 'set', i: s };
      }
    }
    for (let e = 0; e < data.eras.length; e += 1) {
      const era = data.eras[e];
      if (model.setsOnEra[e].length && Math.hypot(era.x - wx, era.y - wy) <= era.r) return { kind: 'era', i: e };
    }
    return null;
  }

  /* ------------------------------------------------------------ camera */

  function zoomAt(sx, sy, factor) {
    const [wx, wy] = toWorld(sx, sy);
    const k = clamp(cam.k * factor, fitK() * 0.6 || MIN_K, MAX_K);
    cam.x = wx - (sx - W / 2) / k;
    cam.y = wy - (sy - H / 2) / k;
    cam.k = k;
    anim = null;
    request();
  }

  function flyTo(ref, opts = {}) {
    const { ms = 700 } = opts;
    if (!W || !H) {
      pendingFly = { ref, opts };
      return;
    }
    if (!ref) {
      anim = { from: { ...cam }, to: { x: 0, y: 0, k: fitK() }, start: performance.now(), ms };
      request();
      return;
    }
    let [x, y] = position(model, ref);
    const span = Math.min(W - inset.right, H - inset.top - inset.bottom);
    let k;
    if (ref.kind === 'species' || ref.kind === 'artist' || ref.kind === 'page') {
      // Frame the whole fan of links, not just the node.
      const pts = computeFocus(ref).lines;
      let [x0, y0, x1, y1] = [x, y, x, y];
      for (let j = 0; j < pts.length; j += 2) {
        x0 = Math.min(x0, pts[j]); x1 = Math.max(x1, pts[j]);
        y0 = Math.min(y0, pts[j + 1]); y1 = Math.max(y1, pts[j + 1]);
      }
      if (pts.length) {
        k = Math.min((W - inset.right) / ((x1 - x0) * 1.15 + 1), (H - inset.top - inset.bottom) / ((y1 - y0) * 1.15 + 1), 6);
        x = (x0 + x1) / 2;
        y = (y0 + y1) / 2;
        k = clamp(k, MIN_K, MAX_K);
        anim = { from: { ...cam }, to: { x: x + inset.right / 2 / k, y: y + (inset.bottom - inset.top) / 2 / k, k }, start: performance.now(), ms };
        request();
        return;
      }
    }
    if (ref.kind === 'card') k = Math.max(cam.k, 22);
    else if (ref.kind === 'set') k = (span * 0.32) / model.setR[ref.i];
    else if (ref.kind === 'era') k = (span * 0.42) / data.eras[ref.i].r;
    else if (ref.kind === 'page') k = Math.max(cam.k, (span * 0.4) / data.radii.core);
    else k = Math.max(cam.k, 5);
    k = clamp(k, MIN_K, MAX_K);
    anim = { from: { ...cam }, to: { x: x + inset.right / 2 / k, y: y + (inset.bottom - inset.top) / 2 / k, k }, start: performance.now(), ms };
    request();
  }

  /* ------------------------------------------------------------ input */

  function local(event) {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  function setHovered(ref, sx, sy) {
    if (!sameRef(ref, hovered)) {
      hovered = ref;
      request();
    }
    onHover(ref, sx, sy);
  }

  function onPointerDown(event) {
    canvas.setPointerCapture(event.pointerId);
    const [sx, sy] = local(event);
    pointers.set(event.pointerId, { sx, sy });
    anim = null;
    if (pointers.size === 1) {
      gesture = { type: 'pan', sx, sy, camX: cam.x, camY: cam.y, moved: 0, t: performance.now() };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { type: 'pinch', dist: Math.hypot(a.sx - b.sx, a.sy - b.sy), k: cam.k, moved: 99 };
    }
  }

  function onPointerMove(event) {
    const [sx, sy] = local(event);
    if (!pointers.has(event.pointerId)) {
      if (event.pointerType === 'mouse') setHovered(hitTest(sx, sy), sx, sy);
      return;
    }
    const prev = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { sx, sy });
    if (gesture?.type === 'pan' && pointers.size === 1) {
      gesture.moved += Math.hypot(sx - prev.sx, sy - prev.sy);
      cam.x = gesture.camX - (sx - gesture.sx) / cam.k;
      cam.y = gesture.camY - (sy - gesture.sy) / cam.k;
      if (gesture.moved > 4) setHovered(null, sx, sy);
      request();
    } else if (gesture?.type === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.sx - b.sx, a.sy - b.sy);
      const mx = (a.sx + b.sx) / 2;
      const my = (a.sy + b.sy) / 2;
      zoomAt(mx, my, (gesture.k * (dist / gesture.dist)) / cam.k);
    }
  }

  function onPointerUp(event) {
    const [sx, sy] = local(event);
    const wasTap = gesture?.type === 'pan' && gesture.moved <= 4 && performance.now() - gesture.t < 600;
    pointers.delete(event.pointerId);
    if (pointers.size === 0) gesture = null;
    if (wasTap) {
      const ref = hitTest(sx, sy);
      onSelect(ref);
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const [sx, sy] = local(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomAt(sx, sy, Math.exp(-delta * 0.0016));
  }

  function onDoubleClick(event) {
    const [sx, sy] = local(event);
    zoomAt(sx, sy, 2.2);
  }

  function onLeave() {
    if (!pointers.size) setHovered(null, 0, 0);
  }

  function onKey(event) {
    const step = 60 / cam.k;
    const keys = {
      '+': () => zoomAt(W / 2, H / 2, 1.5),
      '=': () => zoomAt(W / 2, H / 2, 1.5),
      '-': () => zoomAt(W / 2, H / 2, 1 / 1.5),
      0: () => flyTo(null),
      ArrowLeft: () => { cam.x -= step; request(); },
      ArrowRight: () => { cam.x += step; request(); },
      ArrowUp: () => { cam.y -= step; request(); },
      ArrowDown: () => { cam.y += step; request(); },
      Escape: () => onSelect(null),
    };
    const run = keys[event.key];
    if (run) {
      event.preventDefault();
      run();
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('keydown', onKey);

  return {
    setSelected(ref) {
      selected = ref;
      focus = computeFocus(ref);
      request();
    },
    setMarket(next) {
      mode = next.mode === 'market' ? 'market' : 'structure';
      onlyListed = Boolean(next.onlyListed);
      request();
    },
    setPath(next) {
      path = next && next.length > 1 ? next : null;
      request();
    },
    /** Frame a set of nodes (a path) in the space the panel leaves. */
    frame(refs, { ms = 800 } = {}) {
      if (!refs?.length) return;
      if (!W || !H) {
        pendingFly = { ref: refs[0], opts: { ms } };
        return;
      }
      const pts = refs.map((ref) => position(model, ref));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const k = clamp(Math.min((W - inset.right) / ((x1 - x0) * 1.3 + 20), (H - inset.top - inset.bottom) / ((y1 - y0) * 1.3 + 20), 8), MIN_K, MAX_K);
      anim = { from: { ...cam }, to: { x: (x0 + x1) / 2 + inset.right / 2 / k, y: (y0 + y1) / 2 + (inset.bottom - inset.top) / 2 / k, k }, start: performance.now(), ms };
      request();
    },
    setInset(next) {
      inset = { top: 0, right: 0, bottom: 0, ...next };
    },
    setHidden(next) {
      hidden = new Set(next);
      request();
    },
    flyTo,
    zoom(factor) {
      zoomAt(W / 2, H / 2, factor);
    },
    reset() {
      flyTo(null);
    },
    refreshColors() {
      refreshColors();
      request();
    },
    destroy() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('keydown', onKey);
    },
  };
}
