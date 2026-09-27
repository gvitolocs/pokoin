import assert from 'node:assert/strict';
import test from 'node:test';
import {
  A4_HEIGHT_PT,
  A4_WIDTH_PT,
  buildDesktopPdfBytes,
  CARD_ASPECT,
  desktopHoldCaption,
  desktopHoldFullImage,
  desktopPdfBrandOrigin,
  desktopPdfCellOrigin,
  desktopPdfLayout,
  POKOIN_EXPORT_LABEL,
} from './desktop-hold-pdf.js';

test('desktopPdfLayout packs cards on one A4 with equal 63:88 faces', () => {
  const five = desktopPdfLayout(5);
  assert.ok(five);
  assert.equal(five.count, 5);
  assert.ok(five.cols >= 1 && five.rows >= 1);
  assert.ok(Math.abs(five.cardW / five.cardH - CARD_ASPECT) < 1e-6);
  const gridW = five.cols * five.cardW + (five.cols - 1) * five.gap;
  const gridH = five.rows * (five.cardH + five.labelH) + (five.rows - 1) * five.gap;
  assert.ok(gridW <= A4_WIDTH_PT - five.margin * 2 + 0.01);
  assert.ok(gridH <= A4_HEIGHT_PT - five.topMargin - five.bottomMargin + 0.01);

  const one = desktopPdfLayout(1);
  const many = desktopPdfLayout(20);
  assert.ok(one.cardW > many.cardW);
});

test('desktopPdfCellOrigin keeps every card the same size', () => {
  const layout = desktopPdfLayout(6);
  const a = desktopPdfCellOrigin(layout, 0);
  const b = desktopPdfCellOrigin(layout, 5);
  assert.equal(a.cardW, b.cardW);
  assert.equal(a.cardH, b.cardH);
  assert.ok(a.imageY > b.imageY);
});

test('desktopPdfBrandOrigin sits in the bottom-right with Pokoin Export', () => {
  const layout = desktopPdfLayout(3);
  const brand = desktopPdfBrandOrigin(layout);
  assert.equal(brand.label, POKOIN_EXPORT_LABEL);
  assert.equal(brand.href, 'https://pokoin.com/');
  assert.ok(brand.iconX > A4_WIDTH_PT / 2);
  assert.ok(brand.iconY < layout.bottomMargin);
  assert.ok(brand.textX > brand.iconX);
  assert.equal(brand.linkRect.length, 4);
  assert.ok(brand.linkRect[0] < brand.iconX);
  assert.ok(brand.linkRect[2] > brand.textX);
});

test('desktopHoldCaption is collector + expansion only', () => {
  assert.equal(
    desktopHoldCaption({ collectorNumber: '116/128', expansion: '30th Celebration' }),
    '116/128 - 30th Celebration',
  );
  assert.equal(
    desktopHoldCaption({ collectorNumber: '9/17', expansion: 'POP Series 7' }),
    '9/17 - POP Series 7',
  );
  assert.equal(desktopHoldCaption({ collectorNumber: '090/103' }), '090/103');
  assert.equal(desktopHoldCaption({ expansion: 'Base Set' }), 'Base Set');
  assert.equal(desktopHoldCaption({ name: 'Eevee' }), '');
  assert.equal(POKOIN_EXPORT_LABEL, 'Pokoin.com Export');
});

test('desktopHoldFullImage prefers leftover JPEG with cache bust', () => {
  assert.equal(
    desktopHoldFullImage({
      id: '813554',
      name: 'Eevee',
      imageUrl: '/card-images/406777_eevee_homepage.webp',
      path: '/marketplace/en/cards/813554/card-eevee-116-128-30th-celebration',
    }),
    '/card-images/406777_eevee.jpg?v=wj1',
  );
});

test('buildDesktopPdfBytes writes A4 PDF with brand label', () => {
  const layout = desktopPdfLayout(1);
  const box = desktopPdfCellOrigin(layout, 0);
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
    0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x03, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x7f, 0xff, 0xd9,
  ]);
  const bytes = buildDesktopPdfBytes([{
    box,
    caption: '116/128 - 30th Celebration',
    jpeg,
    pxW: 1,
    pxH: 1,
  }], {
    layout,
    brand: { jpeg, pxW: 1, pxH: 1 },
  });
  const text = Buffer.from(bytes).toString('latin1');
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  assert.match(text, /\/Count 1/);
  assert.match(text, /116\/128/);
  assert.match(text, /Pokoin\.com Export/);
  assert.match(text, /\/ImBrand/);
  assert.match(text, /\/Subtype \/Link/);
  assert.match(text, /\/URI \(https:\/\/pokoin\.com\/\)/);
  assert.match(text, /\/Annots \[/);
  assert.match(text, /%%EOF/);
});
