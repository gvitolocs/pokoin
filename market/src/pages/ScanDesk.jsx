import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { cardFromAutocomplete, fetchLastMedianPknMap, fetchSuggest, formatPkn, imageSrc } from '../api.js';
import { useAuth } from '../auth.jsx';
import { languagesForNationality } from '../locale.js';
import { encodeQr, qrPath } from '../qr.js';
import {
  fetchScanImage,
  phoneConnectUrl,
  rememberActiveSession,
  scanApi,
  streamUrl,
} from '../scan-api.js';
import {
  applyItems,
  batchCounts,
  candidateList,
  CONDITIONS,
  cycleFinish,
  DEFAULTS,
  FINISHES,
  frameEvents,
  LANGUAGES,
  nextAttentionIndex,
  newSubmitKey,
  PROBLEM_LABEL,
  phaseText,
  queueRows,
  rowProblem,
  sessionPhase,
  stepCandidate,
  submitLabel,
  typeQuantity,
} from '../scan-model.js';
import { HELP_SECTIONS, shortcutFor } from '../scan-shortcuts.js';
import { connectScanStream } from '../scan-stream.js';
import { SessionWait } from '../components/Desk.jsx';
import '../scan-desk.css';

const FIELD_LABEL = { reverse: 'Reverse', firstEdition: '1st Ed.', signed: 'Signed', altered: 'Altered' };

function rowsReducer(state, action) {
  switch (action.type) {
    case 'reset':
      return applyItems({}, action.items);
    case 'items':
      return applyItems(state, action.items);
    default:
      return state;
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

/** Performance marks for docs/SCAN_PERFORMANCE.md (window.__pokoinScanPerf). */
function perfSink() {
  if (typeof window === 'undefined') return [];
  window.__pokoinScanPerf = window.__pokoinScanPerf || [];
  return window.__pokoinScanPerf;
}

export default function ScanDesk() {
  const location = useLocation();
  const { user, ready, signedIn, profile, getBearer } = useAuth();
  const uid = user?.uid || profile?.uid || '';
  const [session, setSession] = useState(null);
  const [batch, setBatch] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [rows, dispatch] = useReducer(rowsReducer, {});
  const [pending, setPending] = useState({});
  const [streamStatus, setStreamStatus] = useState('connecting');
  const [error, setError] = useState('');
  const [focusId, setFocusId] = useState('');
  const [selection, setSelection] = useState(() => new Set());
  const [toasts, setToasts] = useState([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [replaceFor, setReplaceFor] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [problems, setProblems] = useState({});
  const [now, setNow] = useState(() => Date.now());
  const [images, setImages] = useState({});
  const qtyBuffer = useRef({ id: '', buffer: '', at: 0 });
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const rowsRef = useRef(rows);
  const pricesAsked = useRef(new Set());
  const queueRef = useRef(null);
  const locationInput = useRef(null);
  const quantityInput = useRef(null);
  const submitKey = useRef(newSubmitKey());
  const followTail = useRef(true);
  rowsRef.current = rows;
  const serverOffsetRef = useRef(serverOffset);
  serverOffsetRef.current = serverOffset;

  // ---------------------------------------------------------------- session

  const token = useCallback((force = false) => getBearer(force), [getBearer]);

  const startSession = useCallback(async (batchId) => {
    setError('');
    try {
      const t = await token();
      const data = await scanApi.start(t, batchId);
      setSession(data.session);
      setBatch(data.batch);
      setPairing(data.pairing);
      setServerOffset(Number(data.serverTime) - Date.now());
      rememberActiveSession(data.session?.id || '');
      const snapshot = await scanApi.batch(t, data.batch.id);
      dispatch({ type: 'reset', items: snapshot.items });
    } catch (err) {
      setError(err.message || 'Scan could not start.');
    }
  }, [token]);

  useEffect(() => {
    document.title = 'Scan · Pokoin';
  }, []);

  useEffect(() => {
    if (!signedIn || !uid) return undefined;
    // A different account in this tab never sees the previous seller's batch.
    setSession(null);
    setBatch(null);
    setPairing(null);
    dispatch({ type: 'reset', items: [] });
    startSession();
    return undefined;
  }, [signedIn, uid, startSession]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // ---------------------------------------------------------------- stream

  useEffect(() => {
    if (!batch?.id) return undefined;
    const perf = perfSink();
    const handle = connectScanStream({
      batchId: batch.id,
      urlFor: (id, cursor) => streamUrl(id, cursor),
      getToken: token,
      onStatus: setStreamStatus,
      onEvent: (name, data) => {
        if (name === 'hello') {
          if (data.session) setSession(data.session);
          if (data.batch) setBatch((current) => ({ ...current, ...data.batch }));
          setServerOffset(Number(data.serverTime) - Date.now());
        } else if (name === 'items') {
          const arrivedAt = Date.now();
          const events = frameEvents(rowsRef.current, data.items);
          dispatch({ type: 'items', items: data.items });
          for (const event of events) {
            if (event.type === 'merged') {
              pushToast({
                id: event.mergedId,
                text: `Qty ${event.from} → ${event.to}`,
                itemId: event.mergedId,
              });
            }
            const item = data.items.find((row) => row.id === (event.id || event.mergedId));
            if (item?.receivedAt && item?.capturedAt) {
              // All in server-clock ms: capturedAt is the phone capture mapped to server time.
              const arrivedServer = arrivedAt + serverOffsetRef.current;
              const captured = Date.parse(item.capturedAt);
              const toRequest = item.timings?.captureToRequestMs ?? null;
              const identify = item.timings?.identifyMs ?? null;
              const resultAt = toRequest != null && identify != null ? captured + toRequest + identify : null;
              requestAnimationFrame(() => {
                if (perf.length > 5000) perf.splice(0, perf.length - 5000);
                perf.push({
                  id: item.id,
                  captureToRequestMs: toRequest,
                  identifyMs: identify,
                  resultToDesktopMs: resultAt != null ? Math.max(0, arrivedServer - resultAt) : null,
                  receivedToDesktopMs: Math.max(0, arrivedServer - Date.parse(item.receivedAt)),
                  frameToRenderMs: Date.now() - arrivedAt,
                  captureToRenderMs: Math.max(0, Date.now() + serverOffsetRef.current - captured),
                  at: Date.now(),
                });
              });
            }
            if (event.type === 'added' && followTail.current) {
              setFocusId(event.id);
            }
          }
        } else if (name === 'session') {
          setSession(data.session);
          if (data.serverTime) setServerOffset(Number(data.serverTime) - Date.now());
          if (data.session?.status === 'waiting') {
            token().then((t) => scanApi.session(t, data.session.id)).then((res) => setPairing(res.pairing)).catch(() => {});
          }
        } else if (name === 'batch') {
          setBatch((current) => ({ ...current, ...data.batch }));
        }
      },
    });
    return () => handle.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.id, token]);

  // ---------------------------------------------------------------- derived

  const displayRows = useMemo(() => {
    const merged = {};
    for (const [id, row] of Object.entries(rows)) {
      merged[id] = pending[id]?.length ? Object.assign({}, row, ...pending[id].map((p) => p.changes)) : row;
    }
    return merged;
  }, [rows, pending]);

  const list = useMemo(() => queueRows(displayRows), [displayRows]);
  const counts = useMemo(() => batchCounts(displayRows), [displayRows]);
  const phase = sessionPhase(session, now, serverOffset);
  const phaseInfo = phaseText(phase, session);
  const defaults = batch?.defaults || DEFAULTS;
  const closed = batch && batch.status !== 'open';
  const focusIndex = list.findIndex((row) => row.id === focusId);
  const focused = focusIndex >= 0 ? list[focusIndex] : null;

  useEffect(() => {
    if (!focusId && list.length) setFocusId(list[list.length - 1].id);
  }, [focusId, list]);

  useEffect(() => {
    if (!focusId || !queueRef.current) return;
    const el = queueRef.current.querySelector(`[data-row="${focusId}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [focusId]);

  // ---------------------------------------------------------------- toasts / undo

  function pushToast(toast) {
    const id = toast.id || `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current.filter((t) => t.id !== id), { ...toast, id }].slice(-4));
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), toast.ms || 6000);
    if (toast.itemId) {
      undoStack.current.push({ label: toast.text, undo: () => runApi((t) => scanApi.unmerge(t, toast.itemId)) });
    }
  }

  async function runApi(fn) {
    const t = await token();
    const data = await fn(t);
    if (data?.items) dispatch({ type: 'items', items: data.items });
    return data;
  }

  async function patchRows(ids, changes, { record = true, label = '' } = {}) {
    const targets = ids.map((id) => rowsRef.current[id]).filter((row) => row && row.status === 'active');
    if (!targets.length) return;
    const tokenId = `${Date.now()}-${Math.random()}`;
    const optimistic = { ...changes };
    delete optimistic.confirm;
    if (changes.confirm) optimistic.reviewed = true;
    if (changes.cardId) {
      const cand = candidateList(targets[0]).find((c) => c.cardId === changes.cardId);
      Object.assign(optimistic, {
        cardName: cand?.name || '',
        setName: cand?.setName || '',
        collectorNumber: cand?.number || '',
        reviewed: true,
      });
    }
    setPending((current) => {
      const next = { ...current };
      for (const row of targets) next[row.id] = [...(next[row.id] || []), { token: tokenId, changes: optimistic }];
      return next;
    });
    if (record) {
      const before = targets.map((row) => [row.id, Object.fromEntries(Object.keys(changes).filter((k) => k !== 'confirm').map((k) => [k, row[k]]))]);
      undoStack.current.push({
        label: label || 'Edit',
        undo: () => Promise.all(before.map(([id, prev]) => (Object.keys(prev).length ? patchRows([id], prev, { record: false }) : null))),
        redo: () => patchRows(ids, changes, { record: false }),
      });
      redoStack.current = [];
    }
    try {
      await Promise.all(targets.map((row) => runApi((t) => scanApi.patch(t, row.id, changes))));
    } catch (err) {
      setError(err.message || 'Change not saved.');
    } finally {
      setPending((current) => {
        const next = { ...current };
        for (const row of targets) {
          next[row.id] = (next[row.id] || []).filter((p) => p.token !== tokenId);
          if (!next[row.id].length) delete next[row.id];
        }
        return next;
      });
    }
  }

  async function setDefaults(patch) {
    if (!batch?.id) return;
    setBatch((current) => ({ ...current, defaults: { ...current.defaults, ...patch } }));
    try {
      const t = await token();
      const data = await scanApi.defaults(t, batch.id, patch);
      setBatch((current) => ({ ...current, ...data.batch }));
    } catch (err) {
      setError(err.message || 'Defaults not saved.');
    }
  }

  async function undo() {
    const entry = undoStack.current.pop();
    if (!entry) return;
    try {
      await entry.undo();
      if (entry.redo) redoStack.current.push(entry);
    } catch (err) {
      setError(err.message || 'Undo failed.');
    }
  }

  async function redo() {
    const entry = redoStack.current.pop();
    if (!entry?.redo) return;
    await entry.redo();
    undoStack.current.push(entry);
  }

  // ---------------------------------------------------------------- row commands

  const targetIds = () => (selection.size ? [...selection] : focused ? [focused.id] : []);

  function move(delta) {
    if (!list.length) return;
    const next = Math.max(0, Math.min(list.length - 1, (focusIndex < 0 ? list.length - 1 : focusIndex) + delta));
    followTail.current = next === list.length - 1;
    setFocusId(list[next].id);
    setSelection(new Set());
  }

  async function removeRows(ids) {
    for (const id of ids) {
      await runApi((t) => scanApi.remove(t, id));
    }
    undoStack.current.push({
      label: 'Remove',
      undo: () => Promise.all(ids.map((id) => runApi((t) => scanApi.restore(t, id)))),
      redo: () => removeRows(ids),
    });
    pushToast({
      text: `${ids.length} removed`,
      action: 'Undo',
      run: () => Promise.all(ids.map((id) => runApi((t) => scanApi.restore(t, id)))),
    });
  }

  async function duplicate(row) {
    const data = await runApi((t) => scanApi.duplicate(t, row.id));
    const copy = data?.items?.[0];
    if (copy) {
      setFocusId(copy.id);
      undoStack.current.push({ label: 'Copy', undo: () => runApi((t) => scanApi.remove(t, copy.id)) });
    }
  }

  function applyAttribute(cmd) {
    if (cmd.target === 'defaults') {
      if (cmd.command === 'set') return setDefaults({ [cmd.field]: cmd.value });
      if (cmd.command === 'toggle') {
        if (cmd.field === 'reverse') return setDefaults({ foilState: defaults.foilState === 'reverse' ? 'standard' : 'reverse' });
        return setDefaults({ [cmd.field]: !defaults[cmd.field] });
      }
      if (cmd.command === 'cycleFinish') return setDefaults({ foilState: cycleFinish(defaults.foilState) });
      return null;
    }
    const ids = targetIds();
    if (!ids.length || !focused) return null;
    if (cmd.command === 'set') return patchRows(ids, { [cmd.field]: cmd.value }, { label: cmd.value });
    if (cmd.command === 'toggle') {
      if (cmd.field === 'reverse') {
        return patchRows(ids, { foilState: focused.foilState === 'reverse' ? 'standard' : 'reverse' }, { label: 'Reverse' });
      }
      return patchRows(ids, { [cmd.field]: !focused[cmd.field] }, { label: FIELD_LABEL[cmd.field] });
    }
    if (cmd.command === 'cycleFinish') return patchRows(ids, { foilState: cycleFinish(focused.foilState) }, { label: 'Finish' });
    return null;
  }

  function confirmFocused() {
    if (!focused) return;
    const problem = rowProblem(focused);
    if ((focused.recognitionState === 'ambiguous' || focused.recognitionState === 'unmatched') && !focused.reviewed && focused.cardId) {
      patchRows([focused.id], { confirm: true }, { label: 'Confirm' });
    } else if (problem === 'no_printing') {
      setReplaceFor(focused.id);
      return;
    }
    const nextIndex = nextAttentionIndex(list.map((row) => (row.id === focused.id ? { ...row, reviewed: true } : row)), focusIndex);
    if (nextIndex >= 0 && nextIndex !== focusIndex) setFocusId(list[nextIndex].id);
    else move(1);
  }

  function quantityDigit(digit) {
    if (!focused) return;
    const buf = qtyBuffer.current;
    const fresh = buf.id !== focused.id || Date.now() - buf.at > 1200;
    const typed = typeQuantity(fresh ? '' : buf.buffer, digit);
    qtyBuffer.current = { id: focused.id, buffer: typed.buffer, at: Date.now() };
    if (typed.quantity) patchRows(targetIds(), { quantity: typed.quantity }, { label: `Qty ${typed.quantity}` });
  }

  const handleCommand = useCallback((cmd) => {
    switch (cmd.command) {
      case 'cancel':
        if (confirmOpen) setConfirmOpen(false);
        else if (replaceFor) setReplaceFor('');
        else if (helpOpen) setHelpOpen(false);
        else {
          setSelection(new Set());
          qtyBuffer.current = { id: '', buffer: '', at: 0 };
          if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
          queueRef.current?.focus();
        }
        return;
      case 'help':
        setHelpOpen((open) => !open);
        return;
      case 'move':
        move(cmd.delta);
        return;
      case 'nextAttention': {
        const i = nextAttentionIndex(list, focusIndex);
        if (i >= 0) setFocusId(list[i].id);
        return;
      }
      case 'set':
      case 'toggle':
      case 'cycleFinish':
        if (!closed) applyAttribute(cmd);
        return;
      case 'confirm':
        if (!closed) confirmFocused();
        return;
      case 'duplicate':
        if (!closed && focused) duplicate(focused);
        return;
      case 'remove':
        if (!closed && targetIds().length) removeRows(targetIds());
        return;
      case 'candidate': {
        if (closed || !focused) return;
        const next = stepCandidate(focused, cmd.delta);
        if (next) patchRows([focused.id], { cardId: next }, { label: 'Printing' });
        return;
      }
      case 'pickCandidate': {
        if (closed || !focused) return;
        const cand = candidateList(focused)[cmd.index];
        if (cand) patchRows([focused.id], { cardId: cand.cardId }, { label: 'Printing' });
        return;
      }
      case 'qtyDigit':
        if (!closed) quantityDigit(cmd.digit);
        return;
      case 'qtyStep':
        if (!closed && focused) {
          const q = Math.max(1, Math.min(99, Number(focused.quantity) + cmd.delta));
          patchRows(targetIds(), { quantity: q }, { label: `Qty ${q}` });
        }
        return;
      case 'qtyBackspace': {
        const buf = qtyBuffer.current;
        if (focused && buf.id === focused.id && buf.buffer.length > 1) {
          const next = buf.buffer.slice(0, -1);
          qtyBuffer.current = { ...buf, buffer: next, at: Date.now() };
          patchRows([focused.id], { quantity: Number(next) });
        }
        return;
      }
      case 'replace':
        if (!closed && focused) setReplaceFor(focused.id);
        return;
      case 'focusDefault':
        (cmd.field === 'location' ? locationInput : quantityInput).current?.focus();
        return;
      case 'pause':
        togglePause();
        return;
      case 'undo':
        undo();
        return;
      case 'redo':
        redo();
        return;
      case 'submit':
        if (!closed && counts.ready) setConfirmOpen(true);
        return;
      default:
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, focusIndex, focused, closed, confirmOpen, replaceFor, helpOpen, counts.ready, selection, defaults]);

  useEffect(() => {
    function onKey(event) {
      // The confirm dialog's button has focus, so Enter there is a native click.
      const cmd = shortcutFor(event, { helpOpen, modalOpen: confirmOpen || Boolean(replaceFor) });
      if (!cmd) return;
      event.preventDefault();
      handleCommand(cmd);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleCommand, helpOpen, confirmOpen, replaceFor]);

  // ---------------------------------------------------------------- prices + images

  useEffect(() => {
    if (closed) return;
    const missing = list
      .filter((row) => row.cardId && row.pricePkn == null && !pricesAsked.current.has(`${row.id}:${row.cardId}`))
      .slice(0, 12);
    if (!missing.length) return;
    for (const row of missing) pricesAsked.current.add(`${row.id}:${row.cardId}`);
    fetchLastMedianPknMap(missing.map((row) => row.cardId)).then((byId) => {
      for (const row of missing) {
        const pkn = byId[row.cardId];
        if (pkn > 0) {
          patchRows([row.id], { pricePkn: Math.round(pkn), priceSuggested: true, onlyIfEmptyPrice: true }, { record: false });
        }
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, closed]);

  useEffect(() => {
    const wanted = list.filter((row) => row.hasImage && (row.recognitionState !== 'matched' || !row.cardId) && !images[row.id]);
    if (!wanted.length) return;
    let cancelled = false;
    (async () => {
      const t = await token();
      for (const row of wanted.slice(0, 6)) {
        try {
          const url = await fetchScanImage(t, row.id);
          if (!cancelled) setImages((current) => ({ ...current, [row.id]: url }));
        } catch (_) {
          if (!cancelled) setImages((current) => ({ ...current, [row.id]: 'none' }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [list, images, token]);

  // ---------------------------------------------------------------- session actions

  async function regenerate() {
    try {
      const t = await token();
      const data = await scanApi.regenerate(t, session.id);
      setPairing(data.pairing);
    } catch (err) {
      if (err.code === 'session_expired') startSession(batch?.id);
      else setError(err.message);
    }
  }

  async function sessionAction(action, extra) {
    try {
      const t = await token();
      const data = action === 'disconnect'
        ? await scanApi.disconnect(t, session.id)
        : action === 'pause'
          ? await scanApi.pause(t, session.id, extra)
          : await scanApi.end(t, session.id, extra);
      setSession(data.session);
      setPairing(data.pairing || null);
      if (action === 'end') rememberActiveSession('');
    } catch (err) {
      setError(err.message);
    }
  }

  function togglePause() {
    if (session && session.status === 'connected') sessionAction('pause', !session.paused);
  }

  async function submit() {
    if (submitting || !batch?.id) return;
    setSubmitting(true);
    setError('');
    try {
      const t = await token();
      const data = await scanApi.submit(t, batch.id, submitKey.current);
      setBatch((current) => ({ ...current, ...data.batch }));
      setConfirmOpen(false);
      setProblems({});
      rememberActiveSession('');
      const snapshot = await scanApi.batch(t, batch.id);
      dispatch({ type: 'items', items: snapshot.items });
      setSession(snapshot.session);
    } catch (err) {
      setConfirmOpen(false);
      if (err.code === 'not_ready') {
        setProblems(Object.fromEntries(err.problems.map((p) => [p.itemId, p.reason])));
        const first = list.findIndex((row) => err.problems.some((p) => p.itemId === row.id));
        if (first >= 0) setFocusId(list[first].id);
      }
      setError(err.message || 'Could not add to inventory.');
    } finally {
      setSubmitting(false);
    }
  }

  async function newBatch() {
    submitKey.current = newSubmitKey();
    pricesAsked.current = new Set();
    dispatch({ type: 'reset', items: [] });
    setBatch(null);
    await startSession();
  }

  // ---------------------------------------------------------------- render

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/inventory/scan')}`} replace />;
  }

  const waiting = session?.status === 'waiting' && pairing;
  const expiresIn = pairing ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - (now + serverOffset)) / 1000)) : 0;

  return (
    <div className="page desk scan-desk">
      <header className="scan-head">
        <div className="scan-head-title">
          <p className="page-kicker">Seller · Scan</p>
          <h1 className="page-title">Scan to inventory</h1>
        </div>
        <div className={`scan-status tone-${phaseInfo.tone}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          <span>{session?.paused ? 'Paused' : phaseInfo.text}</span>
          {streamStatus === 'reconnecting' ? <span className="scan-sub">· dashboard reconnecting</span> : null}
          {session?.phoneScans ? <span className="scan-sub">· {session.phoneScans} scans</span> : null}
        </div>
        <div className="scan-head-actions">
          {session?.status === 'connected' ? (
            <>
              <button type="button" className="btn ghost" onClick={togglePause}>{session.paused ? 'Resume' : 'Pause'}</button>
              <button type="button" className="btn ghost" onClick={() => sessionAction('disconnect')}>Disconnect</button>
            </>
          ) : null}
          {session && session.status === 'ended' && !closed ? (
            <button type="button" className="btn" onClick={() => startSession(batch?.id)}>Start new session</button>
          ) : null}
          <button type="button" className="btn ghost icon-btn" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)">?</button>
          <Link className="btn ghost" to="/inventory">Inventory</Link>
        </div>
      </header>

      {error ? <p className="scan-alert" role="alert">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></p> : null}

      {waiting && !closed ? (
        <section className="scan-connect" aria-label="Connect your phone">
          <div className="scan-connect-main">
            <h2>Connect your phone</h2>
            <p className="scan-connect-step">On your phone open <strong>scan.pokoin.com/connect</strong> and type</p>
            <p className="scan-pin" aria-label={`Pairing code ${pairing.pin.split('').join(' ')}`}>
              {pairing.pin.split('').map((d, i) => <span key={i}>{d}</span>)}
            </p>
            <p className="scan-connect-meta">
              {expiresIn > 0 ? `Code expires in ${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, '0')}` : 'Code expired'}
              {' · '}
              <button type="button" className="linkish" onClick={regenerate}>New code</button>
            </p>
          </div>
          <QrBlock secret={pairing.qrSecret} pin={pairing.pin} />
        </section>
      ) : null}

      {closed ? (
        <section className="scan-done">
          <h2>{batch.status === 'submitted' ? `Added ${batch.submitResult?.cards ?? counts.cards} cards to Inventory` : 'Batch discarded'}</h2>
          <p>{batch.submitResult?.listings ?? 0} listings are live.</p>
          <div className="scan-done-actions">
            <Link className="btn ghost" to="/inventory">Open inventory</Link>
            <button type="button" className="btn" onClick={newBatch}>Scan another batch</button>
          </div>
        </section>
      ) : (
        <DefaultsBar
          defaults={defaults}
          onChange={setDefaults}
          locationRef={locationInput}
          quantityRef={quantityInput}
        />
      )}

      <div className="scan-toolbar">
        <span className="scan-counts">
          <strong>{counts.cards}</strong> cards · {counts.rows} rows
          {counts.merged ? ` · ${counts.merged} repeat${counts.merged === 1 ? '' : 's'} merged` : ''}
          {counts.needsReview ? <button type="button" className="chip warn" onClick={() => handleCommand({ command: 'nextAttention' })}>{counts.needsReview} to check</button> : null}
          {counts.noPrinting ? <span className="chip bad">{counts.noPrinting} unidentified</span> : null}
          {counts.noPrice ? <span className="chip warn">{counts.noPrice} need a price</span> : null}
        </span>
        {!closed ? (
          <button
            type="button"
            className="btn scan-submit"
            disabled={!counts.ready || submitting}
            onClick={() => setConfirmOpen(true)}
            title="⌘Enter"
          >
            {submitting ? 'Adding…' : submitLabel(counts)}
          </button>
        ) : null}
      </div>

      <div
        className="scan-queue"
        role="grid"
        aria-label="Scan queue"
        tabIndex={0}
        ref={queueRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          followTail.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="scan-row scan-row-head" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader" />
          <span role="columnheader">Card</span>
          <span role="columnheader">Lang</span>
          <span role="columnheader">Cond</span>
          <span role="columnheader">Finish</span>
          <span role="columnheader">Flags</span>
          <span role="columnheader">Location</span>
          <span role="columnheader">Qty</span>
          <span role="columnheader">Price</span>
          <span role="columnheader">State</span>
        </div>
        {list.length === 0 ? (
          <p className="scan-empty">
            {session?.status === 'connected' ? 'Scan a card with your phone. It appears here instantly.' : 'Scanned cards appear here.'}
          </p>
        ) : null}
        {list.map((row, index) => (
          <QueueRow
            key={row.id}
            row={row}
            index={index}
            focused={row.id === focusId}
            selected={selection.has(row.id)}
            problem={problems[row.id] || rowProblem(row)}
            image={images[row.id]}
            closed={closed}
            replacing={replaceFor === row.id}
            onFocus={(event) => {
              if (event.shiftKey && focusId) {
                const a = list.findIndex((r) => r.id === focusId);
                const [from, to] = a < index ? [a, index] : [index, a];
                setSelection(new Set(list.slice(from, to + 1).map((r) => r.id)));
              } else {
                setSelection(new Set());
                setFocusId(row.id);
              }
              followTail.current = index === list.length - 1;
            }}
            onPatch={(changes) => patchRows([row.id], changes)}
            onPick={(cardId) => patchRows([row.id], { cardId }, { label: 'Printing' })}
            onReplaceDone={() => {
              setReplaceFor('');
              queueRef.current?.focus();
            }}
          />
        ))}
      </div>

      <div className="scan-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div className="scan-toast" key={toast.id}>
            <span>{toast.text}</span>
            {toast.itemId ? (
              <button type="button" onClick={() => runApi((t) => scanApi.unmerge(t, toast.itemId))}>Undo</button>
            ) : toast.run ? (
              <button type="button" onClick={toast.run}>{toast.action}</button>
            ) : null}
          </div>
        ))}
      </div>

      {confirmOpen ? (
        <div className="scan-modal" role="dialog" aria-modal="true" aria-label="Add to inventory">
          <div className="scan-modal-box">
            <h2>{submitLabel(counts)}?</h2>
            <p>{counts.rows} listings go live on Pokoin now.</p>
            <div className="scan-modal-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirmOpen(false)}>Cancel (Esc)</button>
              <button type="button" className="btn" onClick={submit} disabled={submitting} autoFocus>
                {submitting ? 'Adding…' : 'Add (Enter)'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}

      {typeof window !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1' ? <PerfPanel now={now} /> : null}
    </div>
  );
}

function QrBlock({ secret, pin }) {
  const url = secret ? phoneConnectUrl(secret, pin) : '';
  const path = useMemo(() => {
    if (!url) return null;
    try {
      const qr = encodeQr(url);
      return { d: qrPath(qr), size: qr.size + 8 };
    } catch (_) {
      return null;
    }
  }, [url]);
  if (!path) return null;
  return (
    <figure className="scan-qr" data-connect-url={url}>
      <svg viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label="QR code to connect your phone" shapeRendering="crispEdges">
        <rect width={path.size} height={path.size} fill="#fff" />
        <path d={path.d} fill="#000" />
      </svg>
      <figcaption>Scan with the phone camera — connects by itself</figcaption>
    </figure>
  );
}

function DefaultsBar({ defaults, onChange, locationRef, quantityRef }) {
  const [locationDraft, setLocationDraft] = useState(defaults.location);
  const [qtyDraft, setQtyDraft] = useState(String(defaults.quantity));
  useEffect(() => setLocationDraft(defaults.location), [defaults.location]);
  useEffect(() => setQtyDraft(String(defaults.quantity)), [defaults.quantity]);
  const commitLocation = () => {
    if (locationDraft !== defaults.location) onChange({ location: locationDraft });
  };
  const commitQty = () => {
    const n = Number.parseInt(qtyDraft, 10);
    if (n >= 1 && n <= 99 && n !== defaults.quantity) onChange({ quantity: n });
    else setQtyDraft(String(defaults.quantity));
  };
  const blurOnEnter = (event) => {
    if (event.key === 'Enter') event.currentTarget.blur();
  };
  return (
    <section className="scan-defaults" aria-label="Batch defaults">
      <span className="scan-defaults-label" title="New scans take these values. Shift + a row key changes them.">Batch defaults</span>
      <label className="sd-field">
        <span>Language</span>
        <select value={defaults.language} onChange={(e) => onChange({ language: e.target.value })}>
          {LANGUAGES.map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </label>
      <div className="sd-seg" role="group" aria-label="Condition">
        {CONDITIONS.map((c) => (
          <button key={c} type="button" className={defaults.condition === c ? 'on' : ''} aria-pressed={defaults.condition === c} onClick={() => onChange({ condition: c })}>{c}</button>
        ))}
      </div>
      <label className="sd-field">
        <span>Finish</span>
        <select value={defaults.foilState} onChange={(e) => onChange({ foilState: e.target.value })}>
          {FINISHES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </label>
      <div className="sd-seg" role="group" aria-label="Flags">
        {['firstEdition', 'signed', 'altered'].map((field) => (
          <button key={field} type="button" className={defaults[field] ? 'on' : ''} aria-pressed={defaults[field]} onClick={() => onChange({ [field]: !defaults[field] })}>
            {FIELD_LABEL[field]}
          </button>
        ))}
      </div>
      <label className="sd-field grow">
        <span>Location</span>
        <input
          ref={locationRef}
          value={locationDraft}
          maxLength={64}
          placeholder="Box A12"
          onChange={(e) => setLocationDraft(e.target.value)}
          onBlur={commitLocation}
          onKeyDown={blurOnEnter}
        />
      </label>
      <label className="sd-field qty">
        <span>Qty</span>
        <input
          ref={quantityRef}
          inputMode="numeric"
          value={qtyDraft}
          onChange={(e) => setQtyDraft(e.target.value.replace(/\D/g, '').slice(0, 2))}
          onBlur={commitQty}
          onKeyDown={blurOnEnter}
        />
      </label>
      <label className="sd-check" title="Consecutive identical scans raise the quantity of one row">
        <input type="checkbox" checked={defaults.mergeRepeats} onChange={(e) => onChange({ mergeRepeats: e.target.checked })} />
        <span>Merge repeats</span>
      </label>
    </section>
  );
}

function thumbFor(cardId, name, imageUrl) {
  if (!cardId) return '';
  try {
    return imageSrc({ id: cardId, card_id: cardId, name, imageUrl }, 'suggest');
  } catch (_) {
    return '';
  }
}

function QueueRow({ row, index, focused, selected, problem, image, closed, replacing, onFocus, onPatch, onPick, onReplaceDone }) {
  const stateLabel = row.status === 'submitted'
    ? 'Listed'
    : problem
      ? PROBLEM_LABEL[problem]
      : row.recognitionState === 'manual' ? 'Manual' : row.reviewed && row.recognitionState !== 'matched' ? 'Checked' : 'Matched';
  const tone = row.status === 'submitted' ? 'ok' : problem === 'no_printing' ? 'bad' : problem ? 'warn' : 'ok';
  const candidates = candidateList(row);
  const showCandidates = !closed && (row.recognitionState === 'ambiguous' || row.recognitionState === 'unmatched') && !row.reviewed;
  const allowedLangs = row.nationality ? languagesForNationality(row.nationality, LANGUAGES) : LANGUAGES;
  const langWarn = row.nationality && allowedLangs.length && !allowedLangs.includes(row.language);
  const thumb = thumbFor(row.cardId, row.cardName, row.imageUrl);
  return (
    <div
      className={`scan-row${focused ? ' focused' : ''}${selected ? ' selected' : ''}${row.status === 'submitted' ? ' done' : ''}`}
      role="row"
      aria-selected={focused || selected}
      data-row={row.id}
      onMouseDown={(event) => {
        if (event.target.closest('input,select,button,textarea')) return;
        onFocus(event);
      }}
    >
      <span className="c-num">{index + 1}</span>
      <span className="c-art">
        {showCandidates && image && image !== 'none' ? <img className="scan-shot" src={image} alt="Scanned card" /> : null}
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="art-empty" />}
      </span>
      <span className="c-card">
        <strong>{row.cardName || (row.cardId ? `#${row.cardId}` : 'Not identified')}</strong>
        <em>{[row.setName, row.collectorNumber].filter(Boolean).join(' · ')}</em>
        {showCandidates && candidates.length ? (
          <span className="c-cands">
            {candidates.slice(0, 4).map((cand, i) => (
              <button
                key={cand.cardId}
                type="button"
                className={cand.cardId === row.cardId ? 'on' : ''}
                onClick={() => onPick(cand.cardId)}
                title={`Alt+${i + 1}`}
              >
                <b>{i + 1}</b> {cand.setName || cand.name} {cand.number}
                {cand.score != null ? <i>{Math.round(cand.score * 100)}%</i> : null}
              </button>
            ))}
          </span>
        ) : null}
        {replacing ? <ReplacePrinting onPick={(id) => { onPick(id); onReplaceDone(); }} onClose={onReplaceDone} seed={row.cardName} /> : null}
      </span>
      <span className={`c-lang${langWarn ? ' warn' : ''}`} title={langWarn ? `Not a ${row.nationality} print language` : ''}>
        {closed ? row.language : (
          <select value={row.language} onChange={(e) => onPatch({ language: e.target.value })} tabIndex={-1}>
            {LANGUAGES.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        )}
      </span>
      <span className="c-cond">
        {closed ? row.condition : (
          <select value={row.condition} onChange={(e) => onPatch({ condition: e.target.value })} tabIndex={-1}>
            {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </span>
      <span className="c-finish">
        {closed ? row.foilState : (
          <select value={row.foilState} onChange={(e) => onPatch({ foilState: e.target.value })} tabIndex={-1}>
            {FINISHES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        )}
      </span>
      <span className="c-flags">
        {['firstEdition', 'signed', 'altered'].map((field) => (
          <button
            key={field}
            type="button"
            tabIndex={-1}
            disabled={closed}
            className={row[field] ? 'on' : ''}
            aria-pressed={row[field]}
            onClick={() => onPatch({ [field]: !row[field] })}
          >
            {field === 'firstEdition' ? '1st' : field === 'signed' ? 'S' : 'A'}
          </button>
        ))}
      </span>
      <span className="c-loc">
        {closed ? row.location : (
          <input
            defaultValue={row.location}
            key={`${row.id}:${row.location}`}
            tabIndex={-1}
            maxLength={64}
            onBlur={(e) => {
              if (e.target.value !== row.location) onPatch({ location: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        )}
      </span>
      <span className="c-qty">{row.quantity}</span>
      <span className={`c-price${row.priceSuggested ? ' suggested' : ''}`}>
        {closed ? formatPkn(row.pricePkn) : (
          <input
            inputMode="decimal"
            tabIndex={-1}
            key={`${row.id}:${row.pricePkn}`}
            defaultValue={row.pricePkn ?? ''}
            placeholder="PKN"
            onBlur={(e) => {
              const value = e.target.value.trim();
              const n = Number(value);
              if (value === '' && row.pricePkn == null) return;
              if (value !== '' && (!Number.isFinite(n) || n <= 0)) {
                e.target.value = row.pricePkn ?? '';
                return;
              }
              if (n !== Number(row.pricePkn) || row.priceSuggested) onPatch({ pricePkn: value === '' ? null : n });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        )}
      </span>
      <span className={`c-state tone-${tone}`}>{stateLabel}</span>
    </div>
  );
}

function ReplacePrinting({ onPick, onClose, seed }) {
  const [query, setQuery] = useState(seed || '');
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(0);
  const input = useRef(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchSuggest(q, { limit: 12, signal: controller.signal })
        .then((data) => {
          const cards = (data?.groups || []).flatMap((g) => (g.printings || []).map(cardFromAutocomplete)).filter((c) => /^\d+$/.test(c.id));
          setResults(cards.slice(0, 12));
          setActive(0);
        })
        .catch(() => {});
    }, 120);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);
  return (
    <span className="scan-replace" role="dialog" aria-label="Replace printing">
      <input
        ref={input}
        value={query}
        placeholder="Name, set code or number"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(results.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter' && results[active]) {
            e.preventDefault();
            onPick(results[active].id);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="scan-replace-list" role="listbox">
        {results.map((card, i) => (
          <button
            key={card.id}
            type="button"
            role="option"
            aria-selected={i === active}
            className={i === active ? 'on' : ''}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(card.id);
            }}
          >
            {card.image ? <img src={card.image} alt="" /> : null}
            <span>{card.name}</span>
            <em>{card.set} {card.number}</em>
          </button>
        ))}
      </span>
    </span>
  );
}

function HelpOverlay({ onClose }) {
  return (
    <div className="scan-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={onClose}>
      <div className="scan-modal-box scan-help" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <p className="scan-help-note">Keys act on the focused row when no text field is focused. PowerTools keys work the same way.</p>
        <div className="scan-help-grid">
          {HELP_SECTIONS.map((section) => (
            <section key={section.title}>
              <h3>{section.title}</h3>
              <dl>
                {section.rows.map(([keys, text]) => (
                  <div key={keys}>
                    <dt><kbd>{keys}</kbd></dt>
                    <dd>{text}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <button type="button" className="btn ghost" onClick={onClose}>Close (Esc)</button>
      </div>
    </div>
  );
}

function PerfPanel({ now }) {
  const samples = perfSink();
  const pick = (key) => samples.map((s) => s[key]).filter((v) => Number.isFinite(v));
  const rowsOut = ['captureToRequestMs', 'identifyMs', 'resultToDesktopMs', 'frameToRenderMs', 'captureToRenderMs'].map((key) => {
    const values = pick(key);
    return [key, values.length, median(values), p95(values)];
  });
  return (
    <aside className="scan-perf" data-now={now}>
      {rowsOut.map(([key, n, med, p]) => (
        <span key={key}>{key}: n={n} p50={med ?? '—'} p95={p ?? '—'}</span>
      ))}
    </aside>
  );
}
