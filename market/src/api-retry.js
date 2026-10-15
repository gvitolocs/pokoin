/**
 * api.pokoin.com is a Cloudflare load balancer that picks an origin (the Pi or
 * the nezopt k3s overflow) at random for every request, CORS preflights
 * included. While one origin is down, its share of requests fails at the
 * gateway: a preflight answered 502 makes `fetch` throw before the request is
 * sent, and a 502 / 52x answer never reached a handler. Those failures are
 * retried, so the next pick can land on the healthy origin, instead of
 * painting "The network request failed." on the page.
 */

/** Gateway answers: no handler produced them (502 from the tunnel, Cloudflare 52x/530). */
const GATEWAY_STATUSES = new Set([502, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

/** Waits before the 2nd and 3rd attempt. */
export const API_RETRY_DELAYS_MS = [250, 750];

export function isGatewayStatus(status) {
  return GATEWAY_STATUSES.has(Number(status));
}

/**
 * Reads (GET/HEAD) retry by default. A write retries only when its caller says
 * repeating it is harmless (`retry: true`); `retry: false` turns retries off.
 */
export function retriesRequest(options = {}) {
  if (options.retry === true || options.retry === false) {
    return options.retry;
  }
  const method = String(options.method || 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * Run `attempt()` and repeat it after each delay while it throws an error
 * marked `gatewayFailure`. Any other error, an aborted signal, or the last
 * attempt's failure is thrown as is.
 */
export async function withGatewayRetry(attempt, { retry = true, signal, delays = API_RETRY_DELAYS_MS, wait = sleep } = {}) {
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!retry || !err?.gatewayFailure || index >= delays.length || signal?.aborted) {
        throw err;
      }
      await wait(delays[index], signal);
      if (signal?.aborted) {
        throw err;
      }
    }
  }
}
