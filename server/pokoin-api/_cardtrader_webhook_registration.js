'use strict';

const {
  cardTraderWebhookUrlForUid,
  updateAppWebhookUrl,
} = require('./_cardtrader_client');
const { recordWebhookRegistration } = require('./_cardtrader_integration');

function registeredWebhookUrl(response = {}) {
  const app = response?.app && typeof response.app === 'object' ? response.app : response;
  return String(app?.webhook_url ?? app?.webhookUrl ?? '').trim();
}

function webhookRegistrationMatches(response, expectedUrl) {
  return registeredWebhookUrl(response) === String(expectedUrl || '').trim();
}

async function registerSellerWebhook({ admin, firestore, token, uid }) {
  const webhookUrl = cardTraderWebhookUrlForUid(uid);
  if (!webhookUrl) {
    const error = new Error('Missing CardTrader webhook URL.');
    error.code = 'missing_webhook_url';
    throw error;
  }
  try {
    const response = await updateAppWebhookUrl(token, webhookUrl);
    if (!webhookRegistrationMatches(response, webhookUrl)) {
      const error = new Error('CardTrader did not confirm the requested webhook URL.');
      error.code = 'webhook_not_confirmed';
      throw error;
    }
    await recordWebhookRegistration({ admin, firestore, uid, webhookUrl, ok: true });
    return { ok: true, webhookUrl, response };
  } catch (error) {
    await recordWebhookRegistration({
      admin,
      firestore,
      uid,
      webhookUrl,
      ok: false,
      error: error.message,
    }).catch(() => {});
    throw error;
  }
}

module.exports = {
  registerSellerWebhook,
  registeredWebhookUrl,
  webhookRegistrationMatches,
};
