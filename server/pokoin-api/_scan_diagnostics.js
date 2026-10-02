'use strict';

const DIAGNOSTICS_VERSION = 'scan-diag-v2';
const MAX_ENTRIES = 32;
const seenSessions = new Map();
const text = (v, size = 100) => typeof v === 'string' ? v.slice(0, size) : '';
const number = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
function gate(value) {
  if (!value || typeof value !== 'object') return null;
  return { armed: value.armed === true, emittedId: text(value.emittedId, 32),
    seenSince: number(value.seenSince), clearFrames: number(value.clearFrames),
    swapId: text(value.swapId, 32), swapFrames: number(value.swapFrames) };
}
function cleanEntry(value) {
  if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return null;
  return { sequence: value.sequence, at: number(value.at), kind: text(value.kind, 40),
    capturedAt: number(value.capturedAt), requestAt: number(value.requestAt),
    respondedAt: number(value.respondedAt), detectMs: number(value.detectMs),
    identifyMs: number(value.identifyMs), uploadMs: number(value.uploadMs),
    orientations: number(value.orientations), status: number(value.status),
    error: text(value.error, 40), paused: value.paused === true,
    busy: value.busy === true, emitted: value.emitted === true,
    gateBefore: gate(value.gateBefore), gateAfter: gate(value.gateAfter),
    camera: { time: number(value.camera?.time), ready: number(value.camera?.ready),
      paused: value.camera?.paused === true, hidden: value.camera?.hidden === true,
      width: number(value.camera?.width), height: number(value.camera?.height) },
    boxes: (Array.isArray(value.boxes) ? value.boxes : []).slice(0, 8).map(b => ({
      xyxy: (Array.isArray(b.xyxy) ? b.xyxy : []).slice(0,4).map(number), conf: number(b.conf) })),
    hits: (Array.isArray(value.hits) ? value.hits : []).slice(0,10).map(h => ({
      id: text(String(h.public_id || h.cardId || ''),32), name: text(h.name),
      score: number(h.score), number: text(h.collector_number || h.number),
      set: text(h.setName || h.set_name) })),
    offered: (Array.isArray(value.offered) ? value.offered : []).slice(0,400).map(id => text(String(id),32)),
    chosen: text(value.chosen,32), scanEventId: text(value.scanEventId,80),
    clientVersion: text(value.clientVersion,40) };
}
function recordDiagnostics({ sessionId, batchId, packet, log = console.info, now = Date.now() } = {}) {
  if (!sessionId || packet?.version !== DIAGNOSTICS_VERSION
    || !/^[a-zA-Z0-9-]{16,80}$/.test(packet.runId || '') || !Array.isArray(packet.entries)) return [];
  for (const [key,value] of seenSessions) if (now - value.at > 30 * 60_000) seenSessions.delete(key);
  const key = `${sessionId}:${packet.runId}`;
  let seen = seenSessions.get(key);
  if (!seen) {
    if (seenSessions.size >= 2000) seenSessions.delete(seenSessions.keys().next().value);
    seen = { at: now, sequences: new Set() }; seenSessions.set(key,seen);
  }
  seen.at = now;
  const ack = [];
  for (const raw of packet.entries.slice(0,MAX_ENTRIES)) {
    const row = cleanEntry(raw); if (!row) continue;
    if (!seen.sequences.has(row.sequence)) {
      log('scan-diagnostic', JSON.stringify({ sessionId, batchId, runId: packet.runId,
        version: DIAGNOSTICS_VERSION, receivedAt: now, ...row }));
      seen.sequences.add(row.sequence);
      if (seen.sequences.size > 4096) seen.sequences.delete(seen.sequences.values().next().value);
    }
    ack.push(row.sequence);
  }
  return ack;
}
module.exports = { DIAGNOSTICS_VERSION, MAX_ENTRIES, cleanEntry, recordDiagnostics };
