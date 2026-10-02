const SEARCH_SESSION_TTL_MS = 2 * 60 * 1000;
const MAX_CANCELLED_SESSIONS = 2000;
const cancelledSessions = new Map();

function cleanSearchSessionId(value) {
  const id = String(value || '').trim().slice(0, 120);
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(id)) {
    return '';
  }
  return id;
}

function pruneCancelledSessions(now = Date.now()) {
  for (const [id, entry] of cancelledSessions) {
    if (!entry || entry.expiresAt <= now) {
      cancelledSessions.delete(id);
    }
  }
  while (cancelledSessions.size > MAX_CANCELLED_SESSIONS) {
    const oldestId = cancelledSessions.keys().next().value;
    if (!oldestId) break;
    cancelledSessions.delete(oldestId);
  }
}

function cancelSearchSession(sessionId, metadata = {}) {
  const id = cleanSearchSessionId(sessionId);
  if (!id) {
    return null;
  }
  const now = Date.now();
  pruneCancelledSessions(now);
  const entry = {
    sessionId: id,
    query: String(metadata.query || '').trim().slice(0, 80),
    reason: String(metadata.reason || 'cancel').trim().slice(0, 40) || 'cancel',
    canceledAt: now,
    expiresAt: now + SEARCH_SESSION_TTL_MS,
  };
  cancelledSessions.set(id, entry);
  return entry;
}

function isSearchSessionCancelled(sessionId) {
  const id = cleanSearchSessionId(sessionId);
  if (!id) {
    return false;
  }
  const entry = cancelledSessions.get(id);
  if (!entry) {
    return false;
  }
  if (entry.expiresAt <= Date.now()) {
    cancelledSessions.delete(id);
    return false;
  }
  return true;
}

function clearSearchSessionForTest(sessionId) {
  const id = cleanSearchSessionId(sessionId);
  if (id) {
    cancelledSessions.delete(id);
  }
}

module.exports = {
  cancelSearchSession,
  cleanSearchSessionId,
  clearSearchSessionForTest,
  isSearchSessionCancelled,
  pruneCancelledSessions,
};
