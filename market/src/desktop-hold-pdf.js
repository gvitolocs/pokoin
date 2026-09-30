/** A4 PDF of Desktop hold cards (80 per page) — full leftover scans, equal size. */

import { ownCatalogImage, preferFullImage } from './image-urls.js';

/** A4 in PDF points (1/72"). */
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;
/** Pokemon card face ratio (width : height). */
export const CARD_ASPECT = 63 / 88;

export const POKOIN_EXPORT_LABEL = 'Pokoin.com Export';
export const POKOIN_EXPORT_URL = 'https://pokoin.com/';
export const POKOIN_BRAND_ICON = '/home/logo.png';

const MARGIN_PT = 28;
const GAP_PT = 8;
const LABEL_PT = 11;
const LABEL_FONT_PT = 7;
const BRAND_STRIP_PT = 20;
const BRAND_ICON_PT = 11;
const BRAND_FONT_PT = 8;
/** Cards per A4 page; bigger desktops run to more pages. */
export const PDF_PER_PAGE = 80;

/**
 * Pick cols/rows so every card shares the same box and the grid fills one A4.
 * Maximizes card area; all faces stay 63∶88. Leaves a bottom strip for branding.
 */
export function desktopPdfLayout(count, {
  pageW = A4_WIDTH_PT,
  pageH = A4_HEIGHT_PT,
  margin = MARGIN_PT,
  gap = GAP_PT,
  labelH = LABEL_PT,
  aspect = CARD_ASPECT,
  brandStrip = BRAND_STRIP_PT,
} = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 1) {
    return null;
  }
  const topMargin = margin;
  const bottomMargin = margin + brandStrip;
  let best = null;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const innerW = pageW - margin * 2 - gap * (cols - 1);
    const innerH = pageH - topMargin - bottomMargin - gap * (rows - 1);
    if (innerW <= 0 || innerH <= 0) continue;
    const maxW = innerW / cols;
    const maxH = innerH / rows - labelH;
    if (maxW <= 1 || maxH <= 1) continue;
    let cardW = maxW;
    let cardH = cardW / aspect;
    if (cardH > maxH) {
      cardH = maxH;
      cardW = cardH * aspect;
    }
    const area = cardW * cardH;
    if (!best || area > best.area + 0.01 || (Math.abs(area - best.area) < 0.01 && cols < best.cols)) {
      best = {
        cols,
        rows,
        cardW,
        cardH,
        labelH,
        gap,
        margin,
        topMargin,
        bottomMargin,
        brandStrip,
        pageW,
        pageH,
        area,
        count: n,
      };
    }
  }
  return best;
}

/** Brand mark box in the bottom-right margin strip. */
export function desktopPdfBrandOrigin(layout = {}) {
  const pageW = layout.pageW || A4_WIDTH_PT;
  const margin = layout.margin ?? MARGIN_PT;
  const label = POKOIN_EXPORT_LABEL;
  const labelW = label.length * BRAND_FONT_PT * 0.48;
  const gap = 4;
  const totalW = BRAND_ICON_PT + gap + labelW;
  const x = pageW - margin - totalW;
  const y = margin * 0.45;
  const pad = 2;
  return {
    iconX: x,
    iconY: y,
    iconSize: BRAND_ICON_PT,
    textX: x + BRAND_ICON_PT + gap,
    textY: y + 2,
    fontSize: BRAND_FONT_PT,
    label,
    href: POKOIN_EXPORT_URL,
    // Clickable hit area over icon + "Pokoin.com Export".
    linkRect: [
      x - pad,
      y - pad,
      x + totalW + pad,
      y + BRAND_ICON_PT + pad,
    ],
  };
}

/** Cell origin in PDF coords (origin bottom-left). */
export function desktopPdfCellOrigin(layout, index) {
  if (!layout || index < 0 || index >= layout.count) return null;
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  const gridW = layout.cols * layout.cardW + (layout.cols - 1) * layout.gap;
  const gridH = layout.rows * (layout.cardH + layout.labelH) + (layout.rows - 1) * layout.gap;
  const originX = (layout.pageW - gridW) / 2;
  const availH = layout.pageH - layout.topMargin - layout.bottomMargin;
  const originY = layout.bottomMargin + (availH - gridH) / 2;
  const cellH = layout.cardH + layout.labelH;
  const x = originX + col * (layout.cardW + layout.gap);
  // row 0 at top of page → high y
  const yTop = originY + gridH - row * (cellH + layout.gap);
  const imageY = yTop - layout.cardH;
  const labelY = imageY - layout.labelH + 2;
  return {
    imageX: x,
    imageY,
    labelX: x + layout.cardW / 2,
    labelY,
    cardW: layout.cardW,
    cardH: layout.cardH,
  };
}

export function desktopHoldCaption(row = {}) {
  const number = String(row.collectorNumber || row.number || '').trim();
  const expansion = String(row.expansion || row.setName || row.set || '').trim();
  // ASCII separator only — Helvetica PDF escape turns · into ?.
  if (number && expansion) return `${number} - ${expansion}`;
  return number || expansion || '';
}

/** Full leftover JPEG for print — never the homepage tile. */
export function desktopHoldFullImage(row = {}) {
  const id = String(row.id || row.cardId || '').trim();
  return ownCatalogImage({
    id,
    name: row.name || row.cardName || '',
    canonicalPath: row.path || row.canonicalPath || '',
  }, preferFullImage(row.imageUrl || row.heroImageUrl || '') || row.imageUrl || '') || '';
}

function pdfEscape(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, '?');
}

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

function jpegXObject(jpeg, pxW, pxH) {
  const header = bytesOf(
    `<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} `
    + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`,
  );
  const footer = bytesOf('\nendstream');
  const out = new Uint8Array(header.length + jpeg.byteLength + footer.length);
  out.set(header, 0);
  out.set(jpeg, header.length);
  out.set(footer, header.length + jpeg.byteLength);
  return out;
}

/** Minimal PDF 1.4: one A4 page, JPEG XObjects + Helvetica captions + brand. */
export function buildDesktopPdfBytes(cells, { brand = null, layout = null } = {}) {
  return buildDesktopPdfPagesBytes([{ cells, layout }], { brand });
}

/** One PDF, one A4 page per `{ cells, layout }`; the brand mark repeats per page. */
export function buildDesktopPdfPagesBytes(pages, { brand = null } = {}) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  let brandId = 0;
  if (brand?.jpeg?.byteLength) {
    const pxW = brand.pxW;
    const pxH = brand.pxH;
    const bytes = brand.jpeg;
    brandId = add(() => jpegXObject(bytes, pxW, pxH));
  }
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const pageBodies = [];

  for (const { cells = [], layout = null } of pages || []) {
    const imageIds = [];
    for (const cell of cells) {
      const jpeg = cell.jpeg;
      if (!jpeg?.byteLength) {
        imageIds.push(0);
        continue;
      }
      const pxW = cell.pxW;
      const pxH = cell.pxH;
      imageIds.push(add(() => jpegXObject(jpeg, pxW, pxH)));
    }

    const contentLines = ['q'];
    cells.forEach((cell, i) => {
      const imgId = imageIds[i];
      const { imageX, imageY, labelX, labelY, cardW, cardH } = cell.box;
      if (imgId) {
        contentLines.push(
          'q',
          `${cardW.toFixed(2)} 0 0 ${cardH.toFixed(2)} ${imageX.toFixed(2)} ${imageY.toFixed(2)} cm`,
          `/Im${i} Do`,
          'Q',
        );
      } else {
        contentLines.push(
          '0.85 g',
          `${imageX.toFixed(2)} ${imageY.toFixed(2)} ${cardW.toFixed(2)} ${cardH.toFixed(2)} re f`,
          '0.5 G 0.5 w',
          `${imageX.toFixed(2)} ${imageY.toFixed(2)} ${cardW.toFixed(2)} ${cardH.toFixed(2)} re S`,
        );
      }
      const caption = pdfEscape(cell.caption);
      if (caption) {
        const maxChars = Math.max(8, Math.floor(cardW / (LABEL_FONT_PT * 0.42)));
        const shown = caption.length > maxChars
          ? `${caption.slice(0, Math.max(0, maxChars - 3))}...`
          : caption;
        const textW = shown.length * LABEL_FONT_PT * 0.42;
        const textX = labelX - textW / 2;
        contentLines.push(
          'BT',
          `/F1 ${LABEL_FONT_PT} Tf`,
          '0.15 g',
          `${textX.toFixed(2)} ${labelY.toFixed(2)} Td`,
          `(${shown}) Tj`,
          'ET',
        );
      }
    });

    const brandBox = desktopPdfBrandOrigin(layout || {});
    if (brandId) {
      contentLines.push(
        'q',
        `${brandBox.iconSize.toFixed(2)} 0 0 ${brandBox.iconSize.toFixed(2)} `
        + `${brandBox.iconX.toFixed(2)} ${brandBox.iconY.toFixed(2)} cm`,
        '/ImBrand Do',
        'Q',
      );
    }
    contentLines.push(
      'BT',
      `/F1 ${brandBox.fontSize} Tf`,
      '0.25 g',
      `${brandBox.textX.toFixed(2)} ${brandBox.textY.toFixed(2)} Td`,
      `(${pdfEscape(brandBox.label)}) Tj`,
      'ET',
    );
    contentLines.push('Q');
    const contentStream = contentLines.join('\n');
    const contentId = add(
      `<< /Length ${bytesOf(contentStream).byteLength} >>\nstream\n${contentStream}\nendstream`,
    );

    const [llx, lly, urx, ury] = brandBox.linkRect;
    const linkId = add(
      `<< /Type /Annot /Subtype /Link /Rect [${llx.toFixed(2)} ${lly.toFixed(2)} `
      + `${urx.toFixed(2)} ${ury.toFixed(2)}] /Border [0 0 0] `
      + `/A << /S /URI /URI (${pdfEscape(brandBox.href)}) >> >>`,
    );

    const xObjectParts = imageIds
      .map((id, i) => (id ? `/Im${i} ${id} 0 R` : ''))
      .filter(Boolean);
    if (brandId) {
      xObjectParts.push(`/ImBrand ${brandId} 0 R`);
    }
    const pageId = add('page-placeholder');
    pageIds.push(pageId);
    pageBodies.push({ pageId, contentId, linkId, xObjects: xObjectParts.join(' ') });
  }

  const pagesId = add(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  for (const { pageId, contentId, linkId, xObjects } of pageBodies) {
    objects[pageId - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4_WIDTH_PT} ${A4_HEIGHT_PT}] `
      + `/Resources << /Font << /F1 ${fontId} 0 R >> /XObject << ${xObjects} >> >> `
      + `/Contents ${contentId} 0 R /Annots [${linkId} 0 R] >>`;
  }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const chunks = [bytesOf('%PDF-1.4\n')];
  const offsets = [0];
  let pos = chunks[0].byteLength;
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(pos);
    const body = typeof objects[i] === 'function' ? objects[i]() : bytesOf(String(objects[i]));
    const prefix = bytesOf(`${i + 1} 0 obj\n`);
    const suffix = bytesOf('\nendobj\n');
    chunks.push(prefix, body, suffix);
    pos += prefix.byteLength + body.byteLength + suffix.byteLength;
  }
  const xrefStart = pos;
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (let i = 1; i <= objects.length; i += 1) {
    xref.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(bytesOf(xref.join('')));
  chunks.push(bytesOf(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  ));

  let total = 0;
  for (const part of chunks) total += part.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

async function rasterToJpeg(url, pxW, pxH, { contain = true, fill = '#fff' } = {}) {
  if (!url || typeof document === 'undefined') {
    return null;
  }
  try {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    const abs = new URL(url, typeof location !== 'undefined' ? location.href : 'https://pokoin.com').href;
    img.src = abs;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, pxW, pxH);
    if (contain) {
      const scale = Math.min(pxW / img.naturalWidth, pxH / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, (pxW - dw) / 2, (pxH - dh) / 2, dw, dh);
    } else {
      ctx.drawImage(img, 0, 0, pxW, pxH);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) return null;
    return {
      jpeg: new Uint8Array(await blob.arrayBuffer()),
      pxW,
      pxH,
    };
  } catch (_) {
    return null;
  }
}

async function loadCardJpeg(url, cardWpt, cardHpt) {
  const dpi = 150;
  const pxW = Math.max(120, Math.min(900, Math.round((cardWpt / 72) * dpi)));
  const pxH = Math.max(168, Math.min(1260, Math.round((cardHpt / 72) * dpi)));
  return rasterToJpeg(url, pxW, pxH, { contain: true, fill: '#fff' });
}

async function loadBrandJpeg() {
  // Square mark at print sharpness for the ~11pt footer icon.
  return rasterToJpeg(POKOIN_BRAND_ICON, 96, 96, { contain: true, fill: '#ffffff' });
}

/** Split `count` cards into A4 pages of at most PDF_PER_PAGE, equal size per card. */
export function desktopPdfPagination(count, perPageMax = PDF_PER_PAGE) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 1) return { pages: 0, perPage: 0 };
  const pages = Math.ceil(n / perPageMax);
  return { pages, perPage: Math.ceil(n / pages) };
}

export async function buildDesktopHoldPdf(items = [], { onProgress } = {}) {
  const list = (items || []).filter((row) => row?.id);
  if (!list.length) return null;
  const { perPage } = desktopPdfPagination(list.length);
  // One layout for every page so all cards print the same size.
  const layout = desktopPdfLayout(perPage);
  if (!layout) return null;

  const cells = new Array(list.length);
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (cursor < list.length) {
      const i = cursor;
      cursor += 1;
      const row = list[i];
      const box = desktopPdfCellOrigin(layout, i % perPage);
      const loaded = await loadCardJpeg(desktopHoldFullImage(row), layout.cardW, layout.cardH);
      cells[i] = {
        box,
        caption: desktopHoldCaption(row),
        jpeg: loaded?.jpeg || null,
        pxW: loaded?.pxW || Math.round(layout.cardW),
        pxH: loaded?.pxH || Math.round(layout.cardH),
      };
      done += 1;
      if (typeof onProgress === 'function' && (done % 20 === 0 || done === list.length)) {
        onProgress(done, list.length);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, list.length) }, () => worker()));
  const pages = [];
  for (let i = 0; i < cells.length; i += perPage) {
    pages.push({ cells: cells.slice(i, i + perPage), layout });
  }
  const brand = await loadBrandJpeg();
  return buildDesktopPdfPagesBytes(pages, { brand });
}

export async function downloadDesktopHoldPdf(items = [], { onProgress } = {}) {
  if (typeof document === 'undefined') return false;
  const list = items || [];
  if (!list.length) return false;
  const bytes = await buildDesktopHoldPdf(list, { onProgress });
  if (!bytes?.byteLength) return false;
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pokoin-desktop-${stamp}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
