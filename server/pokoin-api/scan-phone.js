'use strict';

// Paired phone: heartbeat, printing choice, scan events, leave.
// `Authorization: Scan <token>`. The token cannot read batches, listings or
// account data; `printings` answers only with public catalog printings.

const { recordDiagnostics, DIAGNOSTICS_VERSION } = require('./_scan_diagnostics');
const { getScanStore } = require('./_scan_store');
const { applyCors, phoneToken, queryParam, sendError, sendJson } = require('./_scan_http');

module.exports = async function handler(req, res) {
  if (applyCors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  try {
    const token = phoneToken(req);
    if (!token) return sendJson(res, 401, { error: 'This scanner is no longer connected.', code: 'session_ended' });
    const store = getScanStore();
    const action = queryParam(req, 'action');
    if (action === 'heartbeat') {
      // Authenticate first. Diagnostics never trust a client-supplied session ID.
      const heartbeat = await store.heartbeat({ token });
      const diagnosticAck = recordDiagnostics({ sessionId: heartbeat.sessionId,
        batchId: heartbeat.batchId, packet: req.body?.diagnostics });
      return sendJson(res, 200, { ...heartbeat, diagnosticsVersion: DIAGNOSTICS_VERSION, diagnosticAck });
    }
    if (action === 'printings') return sendJson(res, 200, await store.resolvePrintingsForPhone({ token, body: req.body || {} }));
    if (action === 'scan') return sendJson(res, 200, await store.ingestScan({ token, body: req.body || {} }));
    if (action === 'leave') return sendJson(res, 200, await store.leave({ token }));
    return sendJson(res, 400, { error: 'Unknown action.' });
  } catch (error) {
    return sendError(res, error, 'scan-phone');
  }
};
