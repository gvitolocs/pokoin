'use strict';

const crypto = require('node:crypto');

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function verifyWebhookSignature(rawBody, signatureHeader, sharedSecret) {
  const expected = crypto.createHmac('sha256', String(sharedSecret || '')).update(rawBody).digest('base64');
  const provided = String(signatureHeader || '').trim();
  if (!provided || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Direct sales decrement at paid; CardTrader Zero decrements at hub_pending. */
function shouldDecrementStock(order = {}, item = {}) {
  const state = cleanText(order.state, 40).toLowerCase();
  const viaZero = order.via_cardtrader_zero === true;
  if (viaZero && state === 'hub_pending') {
    const hubPendingOrderId = item.hub_pending_order_id ?? item.hubPendingOrderId;
    if (hubPendingOrderId == null || hubPendingOrderId === '') return true;
    return String(hubPendingOrderId) === String(order.id);
  }
  return !viaZero && state === 'paid';
}

function eventDocId(uid, orderId, orderItemId) {
  return `${cleanText(uid, 80)}_${cleanText(orderId, 40)}_${cleanText(orderItemId, 40)}`;
}

function itemProductId(item = {}) {
  const product = item.product && typeof item.product === 'object' ? item.product : {};
  return cleanText(
    item.product_id ?? item.productId ?? item.seller_product_id ?? item.sellerProductId
      ?? product.id ?? product.product_id ?? product.productId,
    80,
  );
}

function itemUserDataField(item = {}) {
  const product = item.product && typeof item.product === 'object' ? item.product : {};
  return cleanText(
    item.user_data_field ?? item.userDataField ?? product.user_data_field ?? product.userDataField,
    160,
  );
}

function orderItemId(item = {}) {
  return cleanText(item.id ?? item.order_item_id ?? item.orderItemId ?? itemProductId(item), 80);
}

module.exports = {
  cleanText,
  eventDocId,
  itemProductId,
  itemUserDataField,
  orderItemId,
  shouldDecrementStock,
  verifyWebhookSignature,
};
