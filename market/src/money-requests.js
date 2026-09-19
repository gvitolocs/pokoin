/** Canonical PKN money-request client — one pipeline for the Receive panel
 * now and chat conversations later. Backend: /api/money-request (authoritative
 * for every status change; the client only displays).
 *
 * api.js is lazy-imported: its module graph pulls .jsx files that the node
 * test runner cannot parse, and these pure helpers are unit-tested. */

const getJson = async (path, options) => {
  const { getJson: getJsonImpl } = await import('./api.js');
  return getJsonImpl(path, options);
};

const AUTH = (token) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

export function newClientToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `tok-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function listMoneyRequests(token) {
  return getJson('/api/money-request?action=list', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function createMoneyRequest({ recipientUsername, amountPkn, note = '', clientToken }, token) {
  return getJson('/api/money-request?action=create', {
    method: 'POST',
    headers: AUTH(token),
    body: JSON.stringify({ recipientUsername, amountPkn, note, clientToken }),
  });
}

export function payMoneyRequest(requestId, token) {
  return getJson('/api/money-request?action=pay', {
    method: 'POST',
    headers: AUTH(token),
    body: JSON.stringify({ requestId }),
  });
}

/** action: 'decline' | 'cancel' */
export function respondMoneyRequest(requestId, action, token) {
  return getJson(`/api/money-request?action=${action}`, {
    method: 'POST',
    headers: AUTH(token),
    body: JSON.stringify({ requestId }),
  });
}

export function fetchNotifications(token) {
  return getJson('/api/money-request?action=notifications', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function markNotificationsRead(token) {
  return getJson('/api/money-request?action=read-notifications', {
    method: 'POST',
    headers: AUTH(token),
    body: '{}',
  });
}

/** Pending incoming requests are the only ones a user may act on. */
export function requestIsPending(request = {}) {
  return request.status === 'pending';
}

export function canPayRequest(request = {}) {
  return request.direction === 'incoming' && requestIsPending(request);
}

/** Status copy — never colour-only, pairs with the badge chip. */
export function requestStatusLabel(status) {
  switch (status) {
    case 'paid':
      return 'Paid ✓';
    case 'declined':
      return 'Declined';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    default:
      return 'Requested';
  }
}

export function unreadNotificationCount(notifications) {
  return (notifications || []).filter((row) => !row.read).length;
}

export function notificationLine(notification = {}) {
  const who = notification.actorUsername ? `@${notification.actorUsername}` : 'Someone';
  const amount = `${notification.amountPkn || 0} PKN`;
  switch (notification.type) {
    case 'money_request_created':
      return `${who} requested ${amount}`;
    case 'money_request_paid':
      return `${who} paid your ${amount} request`;
    case 'money_request_declined':
      return `${who} declined your ${amount} request`;
    case 'money_request_cancelled':
      return `${who} cancelled a ${amount} request`;
    default:
      return notification.type || '';
  }
}
