'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/content';
const API = 'https://merchantapi.googleapis.com/products/v1';

function backoffSeconds(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(3600, 30 * (2 ** (n - 1)));
}

class MerchantApiError extends Error {
  constructor(message, { retrySeconds = 0, reason = 'MERCHANT_API_REJECTED', status = 0 } = {}) {
    super(message);
    this.name = 'MerchantApiError';
    this.retrySeconds = retrySeconds;
    this.reason = reason;
    this.status = status;
  }
}

function logMerchant(event) {
  const safe = { ...(event || {}) };
  delete safe.authorization;
  delete safe.credentials;
  delete safe.private_key;
  delete safe.assertion;
  console.info(JSON.stringify({ msg: 'google_merchant', ...safe }));
}

function loadCredentials(config) {
  if (config.credentialsJson) {
    return JSON.parse(config.credentialsJson);
  }
  if (!config.credentialsPath) return null;
  return JSON.parse(require('fs').readFileSync(config.credentialsPath, 'utf8'));
}

function signJwt(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(credentials.private_key).toString('base64url')}`;
}

class MerchantClient {
  constructor({ config, fetchImpl = fetch, attempts = 1 } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.attempts = attempts;
    this.cachedToken = null;
  }

  dataSourceName() {
    return `accounts/${this.config.accountId}/dataSources/${this.config.dataSourceId}`;
  }

  async accessToken() {
    if (this.cachedToken) return this.cachedToken;
    const credentials = loadCredentials(this.config);
    if (!credentials?.client_email || !credentials?.private_key) {
      throw new MerchantApiError('Google Merchant credentials are not configured.', {
        reason: 'MERCHANT_API_REJECTED',
        retrySeconds: 300,
      });
    }
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(credentials),
    });
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      throw new MerchantApiError(`Merchant token request failed (${response.status}).`, {
        status: response.status,
        retrySeconds: backoffSeconds(this.attempts),
      });
    }
    const json = await response.json();
    this.cachedToken = json.access_token;
    return this.cachedToken;
  }

  async upsertProduct(input) {
    const offerId = input?.offerId || '';
    logMerchant({
      action: 'upsert',
      offerId,
      sellerId: input?.productAttributes?.externalSellerId || '',
      currency: input?.productAttributes?.price?.currencyCode || '',
      dryRun: this.config.dryRun || !this.config.enabled,
    });
    if (!this.config.enabled || this.config.dryRun) {
      return { dryRun: true, offerId };
    }
    return this.request('POST', `accounts/${this.config.accountId}/productInputs:insert?dataSource=${encodeURIComponent(this.dataSourceName())}`, input);
  }

  async deleteProduct({ offerId, contentLanguage = 'en', feedLabel }) {
    logMerchant({
      action: 'delete',
      offerId,
      feedLabel: feedLabel || '',
      dryRun: this.config.dryRun || !this.config.enabled,
    });
    if (!this.config.enabled || this.config.dryRun) {
      return { dryRun: true, offerId };
    }
    const name = `accounts/${this.config.accountId}/productInputs/${contentLanguage}~${feedLabel}~${offerId}`;
    return this.request('DELETE', `${name}?dataSource=${encodeURIComponent(this.dataSourceName())}`);
  }

  async listProducts({ pageToken = '' } = {}) {
    if (!this.config.enabled || this.config.dryRun) {
      return { products: [], nextPageToken: '' };
    }
    const params = new URLSearchParams({ pageSize: '250' });
    if (pageToken) params.set('pageToken', pageToken);
    return this.request('GET', `accounts/${this.config.accountId}/products?${params}`);
  }

  async request(method, path, body) {
    if (!this.config.accountId || !this.config.dataSourceId) {
      throw new MerchantApiError('GOOGLE_MERCHANT_ACCOUNT_ID and GOOGLE_MERCHANT_DATA_SOURCE_ID are required.', {
        reason: 'MERCHANT_API_REJECTED',
        retrySeconds: 300,
      });
    }
    const token = await this.accessToken();
    const response = await this.fetchImpl(`${API}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const detail = String(await response.text()).slice(0, 300);
      throw new MerchantApiError(`Merchant API ${response.status}: ${detail}`, {
        status: response.status,
        retrySeconds: response.status === 429 || response.status >= 500 ? backoffSeconds(this.attempts) : 0,
      });
    }
    if (response.status === 204) return { ok: true };
    const text = await response.text();
    return text ? JSON.parse(text) : { ok: true };
  }
}

module.exports = {
  MerchantApiError,
  MerchantClient,
  backoffSeconds,
  logMerchant,
};
