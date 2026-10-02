function getSupabaseConfig({ serviceRole = false } = {}) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = serviceRole
    ? process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    : process.env.SUPABASE_ANON_KEY || '';

  if (!url || !key) {
    return null;
  }

  return { url, key };
}

async function supabaseFetch(path, options = {}) {
  const config = getSupabaseConfig({ serviceRole: options.serviceRole });
  if (!config) {
    const error = new Error('Supabase is not configured.');
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${config.url}${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(
      `Supabase request failed ${response.status}: ${body.slice(0, 300)}`,
    );
    error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 500;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function encodeFilterValue(value) {
  return encodeURIComponent(String(value).replace(/"/g, '\\"'));
}

module.exports = {
  encodeFilterValue,
  getSupabaseConfig,
  supabaseFetch,
};
