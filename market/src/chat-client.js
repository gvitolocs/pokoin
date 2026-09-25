import { newClientToken } from './money-requests.js';

const getJson = async (path, options) => {
  const { getJson: request } = await import('./api.js');
  return request(path, options);
};

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = (token) => ({ ...authHeaders(token), 'Content-Type': 'application/json' });

export { newClientToken };

export function listConversations(token) {
  return getJson('/api/chat?action=list', { headers: authHeaders(token) });
}

export function getConversation(peer, token, { peerUid = '' } = {}) {
  const params = new URLSearchParams({ action: 'get' });
  if (peerUid) params.set('peerUid', peerUid);
  else params.set('peer', peer);
  return getJson(`/api/chat?${params}`, { headers: authHeaders(token) });
}

export function sendChatMessage(peer, text, token, listings = [], peerUid = '') {
  return getJson('/api/chat?action=message', {
    method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ peer, peerUid, text, listings }),
  });
}

export function sendChatPayment(peer, amountPkn, note, clientToken, token) {
  return getJson('/api/chat?action=pay', {
    method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ peer, amountPkn, note, clientToken }),
  });
}

export function markConversationRead(peer, token) {
  return getJson('/api/chat?action=read', {
    method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ peer }),
  });
}
