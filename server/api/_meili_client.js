function trimSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

function meiliHost() {
  return trimSlashes(
    process.env.MEILI_HOST ||
      process.env.MEILISEARCH_HOST ||
      '',
  );
}

function meiliApiKey() {
  return String(process.env.MEILI_API_KEY || process.env.MEILISEARCH_API_KEY || '');
}

function meiliConfigured() {
  return Boolean(meiliHost());
}

function defaultIndexName() {
  return String(process.env.MEILI_MARKETPLACE_INDEX || 'marketplace_cards');
}

async function meiliRequest(path, options = {}) {
  const host = meiliHost();
  if (!host) {
    const error = new Error('Meilisearch host is not configured.');
    error.code = 'MEILI_NOT_CONFIGURED';
    throw error;
  }
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const key = meiliApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(`${host}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload?.message || `Meili request failed (${response.status})`);
    error.code = 'MEILI_REQUEST_FAILED';
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function meiliHealth() {
  return meiliRequest('/health');
}

async function meiliSearch(indexName, body) {
  return meiliRequest(`/indexes/${encodeURIComponent(indexName)}/search`, {
    method: 'POST',
    body,
  });
}

module.exports = {
  meiliHost,
  meiliApiKey,
  meiliConfigured,
  defaultIndexName,
  meiliRequest,
  meiliHealth,
  meiliSearch,
};
