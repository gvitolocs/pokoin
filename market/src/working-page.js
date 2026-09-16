export const WORKING_MESSAGE = 'We are working on a solution.';
export const WORKING_GIF_SRC = '/home/working.gif';
export const ORIGIN_DOWN_EVENT = 'pokoin-origin-down';
const TUNNEL_RE = /cloudflare tunnel|error code:\s*1033|unable to reach it/i;
const PIPELINE_FAILURE_RE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH|EPIPE|EAI_AGAIN|connect E[A-Z]+|127\.0\.0\.1:\d+|connection refused|too many clients|remaining connection slots|the database system is (starting|shutting)|could not connect to server/i;

export function isOriginDownStatus(status) {
  const code = Number(status);
  return code === 530 || (code >= 520 && code <= 527);
}

export function isTunnelHtml(text) {
  return TUNNEL_RE.test(String(text || ''));
}

export function isApiRequestPath(path) {
  const raw = String(path || '');
  return raw.startsWith('/api') || /https?:\/\/api2?\.pokoin\.com\b/i.test(raw);
}

export function isNetworkError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  return name === 'TypeError' && /failed to fetch|networkerror|load failed/i.test(message);
}

export function isPipelineFailure(text) {
  return PIPELINE_FAILURE_RE.test(String(text || ''));
}

export function isOriginDownError(error, status, raw = '') {
  if (isOriginDownStatus(status ?? error?.status)) {
    return true;
  }
  const message = String(error?.message || '');
  const blob = `${message}\n${raw}`;
  if (message === WORKING_MESSAGE || isTunnelHtml(blob) || isPipelineFailure(blob)) {
    return true;
  }
  return false;
}

export function publicErrorMessage(error, fallback = WORKING_MESSAGE) {
  const message = String(error?.message || '').trim();
  if (!message || isOriginDownError(error, error?.status, message)) {
    return fallback;
  }
  return message;
}

export function noteOriginDown() {
  if (typeof window === 'undefined') {
    return;
  }
  if (window.__pokoinOriginDown) {
    return;
  }
  window.__pokoinOriginDown = true;
  window.dispatchEvent(new Event(ORIGIN_DOWN_EVENT));
}

export function subscribeOriginDown(fn) {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const on = () => fn();
  if (window.__pokoinOriginDown) {
    on();
  }
  window.addEventListener(ORIGIN_DOWN_EVENT, on);
  return () => window.removeEventListener(ORIGIN_DOWN_EVENT, on);
}
