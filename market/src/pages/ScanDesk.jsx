import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { fetchLastMedianPknMap, fetchVersionSet, formatPkn, imageSrc } from '../api.js';
import { useAuth } from '../auth.jsx';
import { encodeQr, qrPath } from '../qr.js';
import {
  fetchScanImage,
  phoneConnectUrl,
  rememberActiveSession,
  scanApi,
  streamUrl,
} from '../scan-api.js';
import {
  artworkVersionLabel,
  artworkVersionShortLabel,
  draftArtworkBucket,
  languagesForPrint,
  listingLanguageForPrint,
  preferArtworkPrinting,
  preferDraftArtwork,
  shouldRemapArtwork,
  sortArtworkVersions,
} from '../scan-artwork-versions.js';
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
import { HELP_SECTIONS, shortcutFor, DRAFT_HOTKEY_LEGEND, draftLegendActive, dispatchDraftHotkey } from '../scan-shortcuts.js';
import { connectScanStream } from '../scan-stream.js';
import { useLiveSuggest } from '../use-live-suggest.js';
import { SessionWait } from '../components/Desk.jsx';
import '../scan-desk.css';

/** CLIP version-set cache keyed by any member card id. */
const versionSetCache = new Map();

function loadVersionSet(cardId) {
  const id = String(cardId || '').trim();
  if (!id) return Promise.resolve(null);
  if (versionSetCache.has(id)) return Promise.resolve(versionSetCache.get(id));
  const pending = fetchVersionSet(id)
    .then((data) => {
      const printings = sortArtworkVersions(data?.printings || []);
      const payload = { printings, version: data?.version || '' };
      versionSetCache.set(id, payload);
      for (const row of printings) {
        const memberId = String(row.id || row.card_id || '');
        if (memberId) versionSetCache.set(memberId, payload);
      }
      return payload;
    })
    .catch(() => {
      versionSetCache.delete(id);
      return null;
    });
  versionSetCache.set(id, pending);
  return pending;
}

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
  /** PowerTools single-card draft: printing picked, Qty focused, hotkeys edit, Enter creates. */
  const [draft, setDraft] = useState(null);
  const qtyBuffer = useRef({ id: '', buffer: '', at: 0 });
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const rowsRef = useRef(rows);
  const pricesAsked = useRef(new Set());
  const queueRef = useRef(null);
  const locationInput = useRef(null);
  const quantityInput = useRef(null);
  const draftQtyRef = useRef(null);
  const addSearchRef = useRef(null);
  const submitKey = useRef(newSubmitKey());
  const followTail = useRef(true);
  rowsRef.current = rows;
  const serverOffsetRef = useRef(serverOffset);
  serverOffsetRef.current = serverOffset;

  // ---------------------------------------------------------------- session

  const token = useCallback((force = false) => getBearer(force), [getBearer]);

  const startSession = useCallback(async (batchId) => {
    setError('');
    const perf = perfSink();
    const t0 = performance.now();
    try {
      const t = await token();
      const tokenMs = Math.round(performance.now() - t0);
      const t1 = performance.now();
      const data = await scanApi.start(t, batchId);
      const startMs = Math.round(performance.now() - t1);
      // Force the PIN/QR tile to paint before the items snapshot fetch.
      // React 18 batches setState across awaits in one async function, so
      // without flushSync the connect tile waited on scan-batch too.
      flushSync(() => {
        setSession(data.session);
        setBatch(data.batch);
        setPairing(data.pairing);
        setServerOffset(Number(data.serverTime) - Date.now());
      });
      rememberActiveSession(data.session?.id || '');
      perf.push({
        kind: 'desk-start',
        tokenMs,
        startMs,
        pairing: Boolean(data.pairing),
        at: Date.now(),
      });
      const t2 = performance.now();
      const snapshot = await scanApi.batch(t, data.batch.id);
      dispatch({ type: 'reset', items: snapshot.items });
      perf.push({
        kind: 'desk-batch',
        batchMs: Math.round(performance.now() - t2),
        items: (snapshot.items || []).length,
        at: Date.now(),
      });
    } catch (err) {
      setError(err.message || 'Scan could not start.');
      perf.push({ kind: 'desk-start-error', message: err.message || '', at: Date.now() });
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
      const nextId = String(changes.cardId);
      const cand = candidateList(targets[0]).find((c) => c.cardId === nextId);
      const cached = versionSetCache.get(nextId);
      const fromVersions = Array.isArray(cached?.printings)
        ? cached.printings.find((p) => String(p.id || p.card_id) === nextId)
        : null;
      const nationality = String(
        fromVersions?.nationality || cand?.nationality || targets[0].nationality || '',
      ).toLowerCase();
      const preferredLang = changes.language || targets[0].language || 'EN';
      Object.assign(optimistic, {
        cardName: cand?.name || fromVersions?.name || targets[0].cardName || '',
        setName: cand?.setName || fromVersions?.set_name || fromVersions?.setName || fromVersions?.set || '',
        collectorNumber: cand?.number
          || fromVersions?.card_number
          || fromVersions?.collector_number
          || fromVersions?.collectorNumber
          || fromVersions?.number
          || '',
        nationality,
        imageUrl: fromVersions?.image_url || fromVersions?.imageUrl || targets[0].imageUrl || '',
        language: listingLanguageForPrint(nationality, preferredLang),
        reviewed: true,
      });
      if (!Object.prototype.hasOwnProperty.call(changes, 'language')) {
        changes.language = optimistic.language;
      }
    } else if (changes.language && targets[0]?.nationality) {
      optimistic.language = listingLanguageForPrint(targets[0].nationality, changes.language);
      changes.language = optimistic.language;
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

  /** PowerTools single-card: pick a printing → draft with Batch Defaults; Qty autofocus. */
  function startDraft(card) {
    if (!card?.id || closed) return;
    const language = defaults.language;
    setDraft({
      cardId: card.id,
      name: card.name || '',
      set: card.set || '',
      number: card.number || '',
      image: card.image || '',
      language,
      condition: defaults.condition,
      foilState: defaults.foilState,
      firstEdition: defaults.firstEdition,
      signed: defaults.signed,
      altered: defaults.altered,
      location: defaults.location,
      quantity: defaults.quantity,
    });
    void remapDraftArtwork(card.id, language);
  }

  /** JP/KO/ID/TH/VI → matching asian expansion; western → western; ZH/ZHT leave the printing. */
  async function remapDraftArtwork(fromCardId, language) {
    if (!draftArtworkBucket(language)) return;
    const data = await loadVersionSet(fromCardId);
    const preferred = preferDraftArtwork(data?.printings || [], fromCardId, language);
    if (!preferred) return;
    const nextId = String(preferred.id || preferred.card_id || '');
    if (!nextId || nextId === String(fromCardId)) return;
    setDraft((current) => {
      if (!current) return null;
      if (String(current.language || '').toUpperCase() !== String(language || '').toUpperCase()) return current;
      if (String(current.cardId) !== String(fromCardId) && String(current.cardId) !== nextId) return current;
      return {
        ...current,
        cardId: nextId,
        name: preferred.name || current.name,
        set: preferred.set_name || preferred.setName || preferred.set || current.set,
        number: preferred.card_number || preferred.collector_number || preferred.number || current.number,
        image: imageSrc({ ...preferred, id: nextId }, 'grid') || current.image,
      };
    });
  }

  useEffect(() => {
    if (!draft) return;
    const id = requestAnimationFrame(() => {
      draftQtyRef.current?.focus();
      draftQtyRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [draft?.cardId]);

  async function commitDraft({ keep = false } = {}) {
    if (!draft || !batch?.id || closed) return;
    const qty = Math.max(1, Math.min(99, Number(draft.quantity) || 1));
    try {
      const data = await runApi((t) => scanApi.add(t, batch.id, {
        cardId: draft.cardId,
        language: draft.language,
        condition: draft.condition,
        foilState: draft.foilState,
        firstEdition: draft.firstEdition,
        signed: draft.signed,
        altered: draft.altered,
        location: draft.location,
        quantity: qty,
      }));
      const item = data?.items?.[0];
      if (item) {
        followTail.current = true;
        setFocusId(item.id);
        undoStack.current.push({
          label: 'Add',
          undo: () => runApi((t) => scanApi.remove(t, item.id)),
        });
        redoStack.current = [];
      }
      if (keep) {
        // Create & copy (PT `c`): stay on the same printing for another identity.
        setDraft((current) => (current ? { ...current, quantity: defaults.quantity } : null));
        requestAnimationFrame(() => {
          draftQtyRef.current?.focus();
          draftQtyRef.current?.select();
        });
      } else {
        setDraft(null);
        requestAnimationFrame(() => addSearchRef.current?.focus());
      }
    } catch (err) {
      setError(err.message || 'Could not add card.');
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
    if (cmd.target === 'draft') {
      if (!draft) return null;
      if (cmd.command === 'set') {
        setDraft((current) => (current ? { ...current, [cmd.field]: cmd.value } : null));
        if (cmd.field === 'language' && draft.cardId) {
          void remapDraftArtwork(draft.cardId, cmd.value);
        }
        return null;
      }
      if (cmd.command === 'toggle') {
        if (cmd.field === 'reverse') {
          setDraft((current) => (current ? {
            ...current,
            foilState: current.foilState === 'reverse' ? 'standard' : 'reverse',
          } : null));
          return null;
        }
        setDraft((current) => (current ? { ...current, [cmd.field]: !current[cmd.field] } : null));
        return null;
      }
      if (cmd.command === 'cycleFinish') {
        setDraft((current) => (current ? { ...current, foilState: cycleFinish(current.foilState) } : null));
        return null;
      }
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
        else if (draft) {
          setDraft(null);
          requestAnimationFrame(() => addSearchRef.current?.focus());
        } else {
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
        if (draft) return;
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
        if (draft) {
          commitDraft({ keep: false });
          return;
        }
        if (!closed) confirmFocused();
        return;
      case 'duplicate':
        if (draft) {
          commitDraft({ keep: true });
          return;
        }
        if (!closed && focused) duplicate(focused);
        return;
      case 'remove':
        if (!closed && targetIds().length) removeRows(targetIds());
        return;
      case 'candidate': {
        if (closed || !focused || draft) return;
        const next = stepCandidate(focused, cmd.delta);
        if (next) patchRows([focused.id], { cardId: next }, { label: 'Printing' });
        return;
      }
      case 'pickCandidate': {
        if (closed || !focused || draft) return;
        const cand = candidateList(focused)[cmd.index];
        if (cand) patchRows([focused.id], { cardId: cand.cardId }, { label: 'Printing' });
        return;
      }
      case 'qtyDigit':
        if (!closed && !draft) quantityDigit(cmd.digit);
        return;
      case 'qtyStep':
        if (draft) {
          const q = Math.max(1, Math.min(99, Number(draft.quantity || 1) + cmd.delta));
          setDraft((current) => (current ? { ...current, quantity: q } : null));
          return;
        }
        if (!closed && focused) {
          const q = Math.max(1, Math.min(99, Number(focused.quantity) + cmd.delta));
          patchRows(targetIds(), { quantity: q }, { label: `Qty ${q}` });
        }
        return;
      case 'qtyBackspace': {
        if (draft) return;
        const buf = qtyBuffer.current;
        if (focused && buf.id === focused.id && buf.buffer.length > 1) {
          const next = buf.buffer.slice(0, -1);
          qtyBuffer.current = { ...buf, buffer: next, at: Date.now() };
          patchRows([focused.id], { quantity: Number(next) });
        }
        return;
      }
      case 'replace':
        if (!closed && focused && !draft) setReplaceFor(focused.id);
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
  }, [list, focusIndex, focused, closed, confirmOpen, replaceFor, helpOpen, counts.ready, selection, defaults, draft]);

  useEffect(() => {
    function onKey(event) {
      // The confirm dialog's button has focus, so Enter there is a native click.
      const cmd = shortcutFor(event, {
        helpOpen,
        modalOpen: confirmOpen || Boolean(replaceFor),
        draftActive: Boolean(draft),
      });
      if (!cmd) return;
      event.preventDefault();
      handleCommand(cmd);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleCommand, helpOpen, confirmOpen, replaceFor, draft]);

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
          {phase !== 'waiting' && session?.phoneScans
            ? <span className="scan-sub">· {session.phoneScans} scans</span>
            : null}
          {phase === 'waiting' && counts.cards
            ? <span className="scan-sub">· {counts.cards} in queue</span>
            : null}
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
            <p className="scan-connect-step">Type the code on <strong>scan.pokoin.com/connect</strong>, or scan the QR code</p>
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
      ) : !closed && !session ? (
        <section className="scan-connect is-loading" aria-label="Connect your phone" aria-busy="true">
          <div className="scan-connect-main">
            <h2>Connect your phone</h2>
            <p className="scan-connect-step">Preparing pairing code…</p>
            <p className="scan-pin scan-pin-skeleton" aria-hidden="true">
              <span /><span /><span /><span />
            </p>
          </div>
          <div className="scan-qr scan-qr-skeleton" aria-hidden="true" />
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

      {!closed ? (
        <ManualAddBar
          draft={draft}
          draftQtyRef={draftQtyRef}
          searchRef={addSearchRef}
          onPickCard={startDraft}
          onDraftChange={setDraft}
          onCreate={() => commitDraft({ keep: false })}
          onCreateCopy={() => commitDraft({ keep: true })}
          onCancelDraft={() => {
            setDraft(null);
            requestAnimationFrame(() => addSearchRef.current?.focus());
          }}
        />
      ) : null}

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
          <span role="columnheader" className="c-remove" aria-label="Remove" />
        </div>
        {list.length === 0 ? (
          <p className="scan-empty">
            {session?.status === 'connected'
              ? 'Scan a card with your phone, or search above to add one.'
              : 'Search above to add a card, or connect your phone to scan.'}
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
            preferredLanguage={defaults.language}
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
            onRemove={() => removeRows([row.id])}
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
      <figcaption>Scan with the phone camera.</figcaption>
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

function ArtworkVersionSelect({ row, closed, preferredLanguage, onPick, onLanguage }) {
  const [printings, setPrintings] = useState(null);
  const remapTried = useRef(new Set());
  const onPickRef = useRef(onPick);
  const onLanguageRef = useRef(onLanguage);
  onPickRef.current = onPick;
  onLanguageRef.current = onLanguage;
  // Batch defaults language is the region intent (EN → western sibling).
  const listingLanguage = preferredLanguage || row.language || 'EN';

  useEffect(() => {
    let cancelled = false;
    const cardId = String(row.cardId || '').trim();
    if (!cardId) {
      setPrintings(null);
      return undefined;
    }
    loadVersionSet(cardId).then((data) => {
      if (cancelled) return;
      const rows = sortArtworkVersions(data?.printings || [], listingLanguage);
      setPrintings(rows);
      if (closed) return;
      const tryKey = `${row.id}\0${listingLanguage}\0${cardId}`;
      if (remapTried.current.has(tryKey)) return;
      remapTried.current.add(tryKey);
      if (shouldRemapArtwork(rows, cardId, listingLanguage)) {
        const preferred = preferArtworkPrinting(rows, cardId, listingLanguage);
        const nextId = String(preferred?.id || preferred?.card_id || '');
        if (nextId && nextId !== cardId) {
          onPickRef.current(nextId);
          return;
        }
      }
      const current = rows.find((p) => String(p.id || p.card_id) === cardId);
      const nationality = String(current?.nationality || row.nationality || '').toLowerCase();
      if (!nationality) return;
      const nextLang = listingLanguageForPrint(nationality, listingLanguage);
      if (nextLang !== row.language) onLanguageRef.current?.(nextLang);
    });
    return () => { cancelled = true; };
  }, [row.cardId, row.id, row.nationality, row.language, closed, listingLanguage]);

  const fallback = [row.setName, row.collectorNumber].filter(Boolean).join(' · ');
  if (closed || !row.cardId) {
    return <em>{fallback}</em>;
  }
  if (!printings) {
    return <em>{fallback || '…'}</em>;
  }
  if (printings.length <= 1) {
    const only = printings[0];
    return <em>{only ? artworkVersionLabel(only) : fallback}</em>;
  }
  const value = printings.some((p) => String(p.id) === String(row.cardId))
    ? String(row.cardId)
    : String(printings[0].id);
  return (
    <label className="c-version-wrap">
      <span className="c-version-tag">Version</span>
      <select
        className="c-version"
        value={value}
        aria-label="Artwork version"
        tabIndex={-1}
        title="Same artwork — pick which printing to list"
        onChange={(e) => onPick(e.target.value)}
      >
        {printings.map((printing) => (
          <option key={printing.id} value={String(printing.id)}>
            {artworkVersionShortLabel(printing)}
          </option>
        ))}
      </select>
    </label>
  );
}

function CandidateAlts({ row, preferredLanguage, onPick }) {
  const raw = candidateList(row);
  const [mapped, setMapped] = useState(raw);
  const lang = preferredLanguage || row.language || 'EN';

  useEffect(() => {
    let cancelled = false;
    const ids = raw.map((c) => c.cardId).join(',');
    if (!ids) {
      setMapped([]);
      return undefined;
    }
    Promise.all(raw.map(async (cand) => {
      const data = await loadVersionSet(cand.cardId);
      const rows = sortArtworkVersions(data?.printings || [], lang);
      if (!rows.length) return cand;
      const preferred = preferArtworkPrinting(rows, cand.cardId, lang);
      if (!preferred) return cand;
      return {
        ...cand,
        cardId: String(preferred.id || preferred.card_id || cand.cardId),
        name: preferred.name || cand.name,
        setName: preferred.set_name || preferred.setName || preferred.set || cand.setName,
        number: preferred.card_number || preferred.collector_number || preferred.number || cand.number,
      };
    })).then((next) => {
      if (cancelled) return;
      const seen = new Set();
      setMapped(next.filter((c) => {
        const id = String(c.cardId || '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      }));
    });
    return () => { cancelled = true; };
  }, [row.id, lang, raw.map((c) => c.cardId).join(',')]);

  if (!mapped.length) return null;
  return (
    <span className="c-cands">
      {mapped.slice(0, 4).map((cand, i) => (
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
  );
}

function QueueRow({
  row, index, focused, selected, problem, image, closed, replacing,
  preferredLanguage,
  onFocus, onPatch, onPick, onRemove, onReplaceDone,
}) {
  const stateLabel = row.status === 'submitted'
    ? 'Listed'
    : problem
      ? PROBLEM_LABEL[problem]
      : row.recognitionState === 'manual' ? 'Manual' : row.reviewed && row.recognitionState !== 'matched' ? 'Checked' : 'Matched';
  const tone = row.status === 'submitted' ? 'ok' : problem === 'no_printing' ? 'bad' : problem ? 'warn' : 'ok';
  const showCandidates = !closed && (row.recognitionState === 'ambiguous' || row.recognitionState === 'unmatched') && !row.reviewed;
  const allowedLangs = languagesForPrint(row.nationality, LANGUAGES);
  const langValue = allowedLangs.includes(row.language)
    ? row.language
    : listingLanguageForPrint(row.nationality, row.language);
  const langWarn = row.nationality && row.language !== langValue;
  const thumb = thumbFor(row.cardId, row.cardName, row.imageUrl);
  const remapLang = preferredLanguage || row.language || 'EN';
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
        <ArtworkVersionSelect
          row={row}
          closed={closed}
          preferredLanguage={remapLang}
          onPick={onPick}
          onLanguage={(language) => onPatch({ language })}
        />
        {showCandidates ? (
          <CandidateAlts row={row} preferredLanguage={remapLang} onPick={onPick} />
        ) : null}
        {replacing ? <ReplacePrinting onPick={(id) => { onPick(id); onReplaceDone(); }} onClose={onReplaceDone} seed={row.cardName} /> : null}
      </span>
      <span className={`c-lang${langWarn ? ' warn' : ''}`} title={langWarn ? `Not a ${row.nationality || 'this'} print language` : ''}>
        {closed ? langValue : (
          <select
            value={langValue}
            onChange={(e) => onPatch({ language: e.target.value })}
            tabIndex={-1}
          >
            {(allowedLangs.length ? allowedLangs : [langValue]).map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
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
      <span className="c-remove">
        {closed ? null : (
          <button
            type="button"
            className="scan-remove"
            tabIndex={-1}
            title="Remove (Backspace)"
            aria-label={`Remove ${row.cardName || 'card'}`}
            onClick={(event) => {
              event.stopPropagation();
              onRemove?.();
            }}
          >
            ×
          </button>
        )}
      </span>
    </div>
  );
}

function PrintingSuggestList({ results, active, onPick }) {
  if (!results.length) return null;
  return (
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
          <em>{[card.set, card.number].filter(Boolean).join(' ')}</em>
        </button>
      ))}
    </span>
  );
}

function suggestKeyDown(e, { results, active, setActive, onPick, onEscape }) {
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
    onEscape?.();
  }
}

/** Header typeahead engine (liveSuggestGroups + fetchSuggestRanked). */
function useScanPrintingSuggest(query) {
  const { results } = useLiveSuggest(query, { kind: 'singles', limit: 20 });
  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    setActive((i) => (results.length ? Math.min(i, results.length - 1) : 0));
  }, [results]);
  return { results, active, setActive };
}

function DraftHotkeyLegend({ draft, qtyRef }) {
  const fire = (entry) => {
    dispatchDraftHotkey(qtyRef?.current, entry);
  };
  const groups = [
    ['Condition', DRAFT_HOTKEY_LEGEND.condition],
    ['Language', DRAFT_HOTKEY_LEGEND.language],
    ['Flags', DRAFT_HOTKEY_LEGEND.toggles],
    ['Actions', DRAFT_HOTKEY_LEGEND.actions],
  ];
  return (
    <div className="scan-hotkey-legend" data-testid="hotkey-legend">
      <p className="scan-hotkey-legend-title">
        Use your keyboard or click a key to edit this card
      </p>
      {groups.map(([title, entries]) => (
        <div key={title} className="scan-hotkey-row" role="group" aria-label={title}>
          <span className="scan-hotkey-row-label">{title}</span>
          <span className="scan-hotkey-chips">
            {entries.map((entry) => {
              const active = draftLegendActive(entry, draft);
              return (
                <button
                  key={`${entry.key}:${entry.label}`}
                  type="button"
                  className={`scan-hotkey-chip${active ? ' on' : ''}`}
                  aria-pressed={active}
                  title={`${entry.key} → ${entry.label}`}
                  onMouseDown={(event) => {
                    // Keep Qty focused (PT legend does the same).
                    event.preventDefault();
                    fire(entry);
                  }}
                >
                  <kbd>{entry.key}</kbd>
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

function ManualAddBar({
  draft,
  draftQtyRef,
  searchRef,
  onPickCard,
  onDraftChange,
  onCreate,
  onCreateCopy,
  onCancelDraft,
}) {
  const [query, setQuery] = useState('');
  const { results, active, setActive } = useScanPrintingSuggest(draft ? '' : query);
  const pick = (cardId) => {
    const card = results.find((row) => row.id === cardId) || { id: cardId };
    onPickCard(card);
    setQuery('');
    setActive(0);
  };

  if (draft) {
    const finishLabel = FINISHES.find((f) => f.value === draft.foilState)?.label || draft.foilState;
    const flags = [
      draft.firstEdition ? '1st' : null,
      draft.signed ? 'Signed' : null,
      draft.altered ? 'Altered' : null,
    ].filter(Boolean).join(' · ');
    return (
      <section className="scan-manual-add is-draft" aria-label="Article being added" data-testid="article-being-added">
        <span className="scan-manual-add-label">Adding</span>
        <div className="scan-draft-card">
          {draft.image ? <img src={draft.image} alt="" /> : <span className="art-empty" />}
          <div className="scan-draft-copy">
            <strong>{draft.name || `#${draft.cardId}`}</strong>
            <em>{[draft.set, draft.number].filter(Boolean).join(' · ')}</em>
          </div>
        </div>
        <label className="scan-draft-qty">
          <span>Qty</span>
          <input
            ref={draftQtyRef}
            data-pokoin-hotkeys="qty"
            data-testid="quanty-input-add-new-article"
            inputMode="numeric"
            autoComplete="off"
            value={draft.quantity === '' || draft.quantity == null ? '' : String(draft.quantity)}
            onChange={(e) => {
              const raw = e.target.value.replace(/\D/g, '').slice(0, 2);
              onDraftChange({
                ...draft,
                quantity: raw === '' ? '' : Number(raw),
              });
            }}
            onFocus={(e) => e.target.select()}
          />
        </label>
        <div className="scan-draft-attrs" aria-live="polite">
          <span>{draft.condition}</span>
          <span>{draft.language}</span>
          <span>{finishLabel}</span>
          {flags ? <span>{flags}</span> : null}
          {draft.location ? <span>{draft.location}</span> : null}
        </div>
        <div className="scan-draft-actions">
          <button type="button" className="btn ghost" onClick={onCancelDraft}>Cancel</button>
          <button type="button" className="btn ghost" onClick={onCreateCopy} title="c">Create &amp; copy</button>
          <button type="button" className="btn" onClick={onCreate} title="Enter">Create</button>
        </div>
        <DraftHotkeyLegend draft={draft} qtyRef={draftQtyRef} />
      </section>
    );
  }

  return (
    <section className="scan-manual-add" aria-label="Add card by name">
      <span className="scan-manual-add-label">Add card</span>
      <div className="scan-manual-add-field">
        <input
          ref={searchRef}
          value={query}
          placeholder="Same as header search — name, set, number…"
          aria-label="Search to add a card"
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => suggestKeyDown(e, {
            results,
            active,
            setActive,
            onPick: pick,
            onEscape: () => {
              if (query) {
                e.stopPropagation();
                setQuery('');
              } else {
                e.currentTarget.blur();
              }
            },
          })}
        />
        <PrintingSuggestList results={results} active={active} onPick={pick} />
      </div>
    </section>
  );
}

function ReplacePrinting({ onPick, onClose, seed }) {
  const [query, setQuery] = useState(seed || '');
  const input = useRef(null);
  const { results, active, setActive } = useScanPrintingSuggest(query);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <span className="scan-replace" role="dialog" aria-label="Replace printing">
      <input
        ref={input}
        value={query}
        placeholder="Same as header search — name, set, number…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => suggestKeyDown(e, {
          results,
          active,
          setActive,
          onPick,
          onEscape: onClose,
        })}
      />
      <PrintingSuggestList results={results} active={active} onPick={onPick} />
    </span>
  );
}

function HelpOverlay({ onClose }) {
  return (
    <div className="scan-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={onClose}>
      <div className="scan-modal-box scan-help" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <p className="scan-help-note">
          PowerTools single-card: after you pick a printing, Qty is focused and the on-screen
          key legend lights up — click a key or type it. Digits type quantity; Enter creates;
          C creates &amp; copies. Queue keys work when no text field is focused.
        </p>
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
  const start = [...samples].reverse().find((s) => s.kind === 'desk-start');
  const batch = [...samples].reverse().find((s) => s.kind === 'desk-batch');
  return (
    <aside className="scan-perf" data-now={now}>
      {start ? (
        <span>
          desk-start: token={start.tokenMs ?? '—'}ms session={start.startMs ?? '—'}ms
          {start.pairing ? ' pairing=yes' : ' pairing=no'}
        </span>
      ) : null}
      {batch ? <span>desk-batch: {batch.batchMs ?? '—'}ms items={batch.items ?? 0}</span> : null}
      {rowsOut.map(([key, n, med, p]) => (
        <span key={key}>{key}: n={n} p50={med ?? '—'} p95={p ?? '—'}</span>
      ))}
    </aside>
  );
}
