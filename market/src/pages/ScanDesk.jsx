import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, Navigate, useLocation } from 'react-router-dom';
import {
  fetchCardSales,
  fetchCheapestPricePknMap,
  fetchExactNameCards,
  fetchSellerListings,
  fetchVersionSet,
  imageSrc,
} from '../api.js';
import {
  continueBoxCursor,
  listingBox,
  liveInventoryListings,
  nextPositionInStack,
  occupiedAbsForScanBoxes,
  recentBoxes,
} from '../inventory-listings.js';
import { useSellerCurrency } from '../use-seller-currency.js';
import { formatSellerPrice, priceInputFromPkn } from '../seller-currency.js';
import { cardReference, writeListingDrag } from '../chat-listing.js';
import { useAuth } from '../auth.jsx';
import { encodeQr, qrPath, qrLogoLayout } from '../qr.js';
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
  batchDefaultRowPatch,
  candidatesForPrintFamily,
  currentMatchesLanguageBucket,
  draftArtworkBucket,
  listingLanguageForPrint,
  mergeArtworkCandidates,
  preferArtworkPrinting,
  preferDraftArtwork,
  remapListingLanguage,
  resolveArtworkRemap,
  shouldRemapArtwork,
  sortArtworkVersions,
} from '../scan-artwork-versions.js';
import {
  applyItems,
  batchCounts,
  boxSlots,
  stackPosToIndex,
  indexToStackPos,
  candidateList,
  CONDITIONS,
  createPatchChain,
  cycleFinish,
  DEFAULTS,
  FINISHES,
  frameEvents,
  LANGUAGES,
  nextAttentionIndex,
  nextBoxPositions,
  newSubmitKey,
  PROBLEM_LABEL,
  phaseText,
  queueRows,
  rowProblem,
  sessionPhase,
  slotText,
  stepCandidate,
  submitLabel,
  suggestedStartPosition,
  suggestedStackCursor,
  STACK_SIZES,
  slotFilledStack,
  typeQuantity,
  locationDefaultsText,
  quantityFieldCommit,
} from '../scan-model.js';
import { HELP_SECTIONS, shortcutFor, DRAFT_HOTKEY_LEGEND, draftLegendActive, dispatchDraftHotkey } from '../scan-shortcuts.js';
import {
  facetSignature,
  priceFieldCommit,
  scanFacets,
  suggestPriceFromSlices,
} from '../scan-pricing.js';
import { connectScanStream } from '../scan-stream.js';
import { useLiveSuggest } from '../use-live-suggest.js';
import { SessionWait } from '../components/Desk.jsx';
import InventoryTargets from '../components/InventoryTargets.jsx';
import ThumbZoom from '../components/ThumbZoom.jsx';
import { game, GAMES, setScanGameOverride, gameIdFromHost, gameBasename } from '../game.js';
import { conditionChipSrc } from '../listing-meta.js';
import { flagSrc } from '../locale.js';
import { marketUrl } from '../punchouts.js';
import '../scan-desk.css';

/** CLIP version-set cache keyed by any member card id. */
const versionSetCache = new Map();

const BOX_POSITIONS_KEY = 'scan:box-positions';

/** Where the seller stopped in each box, so the next session's Start
 * position defaults there. localStorage: the scan desk is one browser. */
function loadStoppedPositions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BOX_POSITIONS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function rememberStoppedPositions(next) {
  try {
    localStorage.setItem(BOX_POSITIONS_KEY, JSON.stringify(next));
  } catch (_) { /* private mode etc. — the suggestion is best effort */ }
}

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
  // Sellers who opted out of PKN payments price the queue in local currency.
  const { currency: priceCurrency } = useSellerCurrency();
  const [session, setSession] = useState(null);
  const [batch, setBatch] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [idleDisconnectNote, setIdleDisconnectNote] = useState(false);
  const [serverOffset, setServerOffset] = useState(0);
  const [rows, dispatch] = useReducer(rowsReducer, {});
  const [pending, setPending] = useState({});
  const [streamStatus, setStreamStatus] = useState('connecting');
  const [error, setError] = useState('');
  const [focusId, setFocusId] = useState('');
  const [selection, setSelection] = useState(() => new Set());
  const [toasts, setToasts] = useState([]);
  const [stackFull, setStackFull] = useState(false);
  const stackFullTimer = useRef(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [replaceFor, setReplaceFor] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [problems, setProblems] = useState({});
  /** Finalize intent: list → listings+ownership; collection → ownership only. */
  const [submitIntent, setSubmitIntent] = useState('list');
  const [now, setNow] = useState(() => Date.now());
  const [images, setImages] = useState({});
  // Bumped to re-run the price suggestion effect for a row whose price field was emptied.
  const [priceRetry, setPriceRetry] = useState(0);
  /** PowerTools single-card draft: printing picked, Qty focused, hotkeys edit, Enter creates. */
  const [draft, setDraft] = useState(null);
  const qtyBuffer = useRef({ id: '', buffer: '', at: 0 });
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const rowsRef = useRef(rows);
  const displayRowsRef = useRef(rows);
  const pricesAsked = useRef(new Set());
  const slicesCache = useRef(new Map());
  const priceTouched = useRef(new Set());
  const suggestedFor = useRef(new Map());
  // rowId → { signature, pkn }: the last default price, restored when the
  // price field is left empty.
  const lastSuggested = useRef(new Map());
  const patchChain = useRef(createPatchChain());
  const remapTried = useRef(new Set());
  const queueRef = useRef(null);
  const locationInput = useRef(null);
  const stackButton = useRef(null);
  const draftQtyRef = useRef(null);
  const addSearchRef = useRef(null);
  const submitKey = useRef(newSubmitKey());
  const pendingTargets = useRef({ pokoin: true, cardtrader: false });
  const followTail = useRef(true);
  const intentionalDisconnect = useRef(false);
  const wasPhoneConnected = useRef(false);
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
          const events = frameEvents(rowsRef.current, data.items, {
            serverNowMs: arrivedAt + serverOffsetRef.current,
          });
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
            if (event.type === 'added' && item) {
              console.info('[scan-desk] dashboard-row', {
                itemId: item.id,
                recognitionState: item.recognitionState,
                cardId: item.cardId || null,
                name: item.cardName || item.name || null,
                set: item.setName || null,
                number: item.collectorNumber || null,
                score: item.recognition?.topScore ?? null,
                seq: item.seq,
              });
            }
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
          const next = data.session;
          if (wasPhoneConnected.current && next?.status === 'waiting' && !intentionalDisconnect.current) {
            setIdleDisconnectNote(true);
          }
          if (next?.status === 'connected') {
            setIdleDisconnectNote(false);
            intentionalDisconnect.current = false;
          }
          wasPhoneConnected.current = next?.status === 'connected';
          setSession(next);
          if (data.serverTime) setServerOffset(Number(data.serverTime) - Date.now());
          if (next?.status === 'waiting') {
            token().then((t) => scanApi.session(t, next.id)).then((res) => {
              setPairing(res.pairing);
              if (res.justIdleDisconnected) setIdleDisconnectNote(true);
            }).catch(() => {});
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
  displayRowsRef.current = displayRows;

  const list = useMemo(() => queueRows(displayRows), [displayRows]);
  const [boxStockRows, setBoxStockRows] = useState([]);
  const [recentBoxNames, setRecentBoxNames] = useState([]);
  const occupiedAbs = useMemo(
    () => occupiedAbsForScanBoxes(list, boxStockRows),
    [list, boxStockRows],
  );
  const slots = useMemo(() => boxSlots(list, { occupiedAbs }), [list, occupiedAbs]);
  const counts = useMemo(
    () => batchCounts(displayRows, { intent: submitIntent }),
    [displayRows, submitIntent],
  );
  const phase = sessionPhase(session, now, serverOffset);
  const phaseInfo = phaseText(phase, session);
  const defaults = batch?.defaults || DEFAULTS;
  const closed = batch && batch.status !== 'open';

  // Push Game picker (dashboard localStorage override) into batch defaults once a batch exists.
  useEffect(() => {
    if (!batch?.id || closed) return;
    const id = gameIdFromHost();
    if ((defaults.game || 'pokemon') === id) return;
    setDefaults({ game: id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.id, closed]);
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

  // The queue is part of the page. Follow new scans only while the seller
  // is already at the bottom of that page.
  useEffect(() => {
    const onScroll = () => {
      const el = queueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      followTail.current = rect.bottom - window.innerHeight < 80;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Keep where the seller stopped per box (stack + position) so the next
  // session can resume at the same divider. An empty batch has not placed a
  // card yet: writing its pristine 1·1 here erased the stop before the resume
  // effect below could read it. Explicit Stack/Position edits are remembered
  // in setDefaults.
  useEffect(() => {
    const size = Math.max(1, Math.trunc(Number(defaults.stackSize)) || 1);
    if (!list.length) return;
    const next = nextBoxPositions(list, { occupiedAbs });
    const store = loadStoppedPositions();
    let dirty = false;
    for (const [box, cursor] of next) {
      const prev = store[box];
      if (!prev || prev.stack !== cursor.stack || prev.startPosition !== cursor.startPosition) {
        store[box] = {
          stack: cursor.stack,
          startPosition: cursor.startPosition,
          stackSize: cursor.stackSize || size,
        };
        dirty = true;
      }
    }
    if (dirty) rememberStoppedPositions(store);
  }, [list, occupiedAbs, defaults.location, defaults.startPosition, defaults.stack, defaults.stackSize]);

  // Advance Stack / Position as cards land, and flash when a divider fills.
  const prevListLenRef = useRef(0);
  useEffect(() => {
    const loc = String(defaults.location || '').trim();
    const len = list.length;
    const grew = len > prevListLenRef.current;
    prevListLenRef.current = len;
    if (!loc || !grew || !len) return;
    const size = Math.max(1, Math.trunc(Number(defaults.stackSize)) || 1);
    const slots = boxSlots(list);
    const last = list[list.length - 1];
    const slot = last && slots.get(last.id);
    // Size 1 = one card per divider: nothing "fills", so never flash/toast.
    if (size > 1 && slot && slotFilledStack(slot)) {
      setStackFull(true);
      if (stackFullTimer.current) clearTimeout(stackFullTimer.current);
      stackFullTimer.current = setTimeout(() => setStackFull(false), 2800);
      pushToast({ text: `Stack ${slot.stack} full — next divider`, ms: 3200 });
    } else if (size === 1 && stackFull) {
      setStackFull(false);
    }
    const next = nextBoxPositions(list, { occupiedAbs }).get(loc);
    if (!next) return;
    const patch = {};
    if (next.stack !== (defaults.stack ?? 1)) patch.stack = next.stack;
    if (next.startPosition !== (defaults.startPosition ?? 1)) patch.startPosition = next.startPosition;
    if (Object.keys(patch).length) setDefaults(patch);
  }, [list, occupiedAbs]);

  // Resume stack/position when the seller switches box (or opens a batch).
  const prevLocationRef = useRef(undefined);
  const prevBatchRef = useRef(undefined);
  useEffect(() => {
    const loc = String(defaults.location || '').trim();
    if (closed || !batch?.id) {
      prevLocationRef.current = loc;
      prevBatchRef.current = batch?.id;
      return;
    }
    const locationChanged = prevLocationRef.current !== loc;
    const batchChanged = prevBatchRef.current !== batch.id;
    prevLocationRef.current = loc;
    prevBatchRef.current = batch.id;
    if (!loc || (!locationChanged && !batchChanged)) return;
    const suggested = suggestedStackCursor({
      stored: loadStoppedPositions()[loc],
      currentStack: defaults.stack ?? 1,
      currentPosition: defaults.startPosition ?? 1,
      stackSize: defaults.stackSize ?? 1,
      locationChanged: true,
    });
    // A stored stop only moves the cursor forward. Stock that already sits
    // further on (the last stack) must not be rewound to an older session.
    if (suggested) {
      const size = Math.max(1, Math.trunc(Number(defaults.stackSize)) || 1);
      const hintAbs = stackPosToIndex(suggested.stack, suggested.startPosition, size);
      const nowAbs = stackPosToIndex(defaults.stack ?? 1, defaults.startPosition ?? 1, size);
      if (hintAbs > nowAbs) setDefaults(suggested);
    }
  }, [batch?.id, defaults.location, closed]);

  // A batch never starts on top of stock already in the box: continue after
  // the last slot the seller's live listings hold there (scan sessions, desk
  // listings and PowerTools CSV imports all write `box·stack[·position]`).
  // With stacks of N cards a half-full stack continues at its next position.
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const boxStockRef = useRef({ key: '', box: '', rows: [] });
  const stockUid = user?.uid || profile?.uid || '';
  useEffect(() => {
    const loc = String(defaults.location || '').trim();
    if (closed || !batch?.id || !loc || !stockUid) return undefined;
    const box = listingBox(loc);
    const key = `${batch.id}|${box}`;
    if (boxStockRef.current.key === key) return undefined;
    boxStockRef.current = { key, box, rows: [] };
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchSellerListings(stockUid, await getBearer(), { limit: 1000 });
        if (cancelled) return;
        const rows = liveInventoryListings(data.listings || data.items || []);
        boxStockRef.current = { key, box, rows };
        setBoxStockRows(rows);
        const d = defaultsRef.current;
        if (listingBox(String(d.location || '').trim()) !== box) return;
        const size = Math.max(1, Math.trunc(Number(d.stackSize)) || 1);
        const next = continueBoxCursor(rows, box, size);
        if (!next) return;
        const nextIndex = stackPosToIndex(next.stack, next.startPosition, next.stackSize);
        if (nextIndex > stackPosToIndex(d.stack ?? 1, d.startPosition ?? 1, size) || next.stackSize !== size) {
          setDefaults({
            stack: Math.min(9999, next.stack),
            startPosition: next.stackSize === 1 ? 1 : next.startPosition,
            ...(next.stackSize !== size ? { stackSize: next.stackSize } : {}),
          });
        }
      } catch (_) {
        boxStockRef.current = { key: '', box: '', rows: [] }; // retry on the next location change
        setBoxStockRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [batch?.id, defaults.location, closed, stockUid]); // eslint-disable-line react-hooks/exhaustive-deps

  // An empty location suggests the box on the seller's newest listing.
  // One shot per batch: clearing the field afterwards stays cleared.
  const locationSeeded = useRef('');
  useEffect(() => {
    if (closed || !batch?.id || !stockUid) return undefined;
    if (String(defaults.location || '').trim()) {
      locationSeeded.current = batch.id;
      return undefined;
    }
    if (locationSeeded.current === batch.id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchSellerListings(stockUid, await getBearer(), { limit: 200 });
        if (cancelled || locationSeeded.current === batch.id) return;
        const rows = liveInventoryListings(data.listings || data.items || []);
        const boxes = recentBoxes(rows);
        setRecentBoxNames(boxes);
        setBoxStockRows((current) => (current.length ? current : rows));
        const last = boxes[0];
        if (!last || String(defaultsRef.current.location || '').trim()) return;
        locationSeeded.current = batch.id;
        setDefaults({ location: last });
      } catch (_) { /* the field stays empty; the seller can still type a box */ }
    })();
    return () => { cancelled = true; };
  }, [batch?.id, defaults.location, closed, stockUid]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Next free position when the seller types a stack: stock in the box plus this batch. */
  function positionForStack(stack) {
    const loc = String(defaults.location || '').trim();
    const size = Math.max(1, Math.trunc(Number(defaults.stackSize)) || 1);
    if (!loc || size === 1) return null;
    const box = listingBox(loc);
    const stock = boxStockRef.current.box === box ? boxStockRef.current.rows : [];
    let next = nextPositionInStack(stock, box, stack, size) || 1;
    for (const row of list) {
      if (listingBox(String(row.location || '').trim()) !== box) continue;
      const slot = slots.get(row.id);
      if (!slot || stack < slot.stack || stack > (slot.endStack || slot.stack)) continue;
      const end = (slot.endStack || slot.stack) > stack ? size : slot.end;
      next = Math.max(next, end + 1);
    }
    return next;
  }

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

  // An explicit version pick is authoritative: pre-mark the artwork-remap
  // guard so the region-remap effect doesn't bounce the row back to the
  // batch-language sibling on the first click.
  function markPick(row, nextId) {
    const lang = remapListingLanguage(row.language, defaults.language);
    remapTried.current.add(`${row.id}\0${lang}\0${String(nextId)}`);
  }

  /** An emptied price field falls back to the default price, never "Needs a price". */
  function restoreDefaultPrice(row) {
    priceTouched.current.delete(row.id);
    if (row.priceSuggested && row.pricePkn != null) return;
    const signature = facetSignature(row);
    const last = lastSuggested.current.get(row.id);
    if (last?.signature === signature) {
      patchRows([row.id], { pricePkn: last.pkn, priceSuggested: true }, { label: 'Price' });
      return;
    }
    // No default known for this printing yet: clear it so the price effect asks again.
    pricesAsked.current.delete(`${row.id}:${signature}`);
    suggestedFor.current.delete(row.id);
    if (row.pricePkn != null) {
      patchRows([row.id], { pricePkn: null, priceSuggested: false }, { label: 'Price' });
    } else {
      setPriceRetry((n) => n + 1);
    }
  }

  async function patchRows(ids, changes, { record = true, label = '' } = {}) {
    // Prefer displayRows (includes in-flight pending) so a version remap right
    // after Batch Defaults → IT does not stomp language back to stale EN.
    const source = displayRowsRef.current;
    const targets = ids.map((id) => source[id] || rowsRef.current[id]).filter((row) => row && row.status === 'active');
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
      const preferredLang = changes.language || targets[0].language || defaults.language || 'EN';
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
        // After a version remap, align listing lang to the new print region.
        // Language-only edits keep the chosen code — expansion remaps separately.
        language: listingLanguageForPrint(nationality, preferredLang),
        reviewed: true,
      });
      if (!Object.prototype.hasOwnProperty.call(changes, 'language')) {
        changes.language = optimistic.language;
      }
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
      // Serialize per row: the version-switch patch (which clears the stale
      // price) must land before the follow-up price suggestion is sent, or the
      // server applies them out of order and wipes the fresh suggestion.
      await Promise.all(targets.map((row) => patchChain.current(
        row.id,
        () => runApi((t) => scanApi.patch(t, row.id, changes)),
      )));
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

  // Quantity is never a batch default: each scan is one card (repeats merge
  // when Merge repeats is on). Older batches saved another Qty — reset it so
  // the phone stops stamping it on every capture.
  useEffect(() => {
    if (!batch?.id || closed) return;
    if ((Math.trunc(Number(batch.defaults?.quantity)) || 1) !== 1) setDefaults({ quantity: 1 });
  }, [batch?.id, batch?.defaults?.quantity, closed]); // eslint-disable-line react-hooks/exhaustive-deps

  async function setDefaults(patch) {
    if (!batch?.id) return;
    let nextPatch = { ...patch };
    // Typing a box after cards were scanned empty: look at live stock in that
    // box and resume stack/position after the last taken slot before rows get
    // the bare location (otherwise every row anchors at ·1 and collides).
    if (Object.prototype.hasOwnProperty.call(patch, 'location') && stockUid) {
      const loc = String(patch.location || '').trim();
      if (loc) {
        const box = listingBox(loc);
        const size = Math.max(1, Math.trunc(Number(patch.stackSize ?? defaults.stackSize)) || 1);
        try {
          const data = await fetchSellerListings(stockUid, await getBearer(), { limit: 1000 });
          const rows = liveInventoryListings(data.listings || data.items || []);
          boxStockRef.current = { key: `${batch.id}|${box}`, box, rows };
          setBoxStockRows(rows);
          setRecentBoxNames(recentBoxes(rows));
          const next = continueBoxCursor(rows, box, size);
          if (next && patch.stack == null && patch.startPosition == null) {
            nextPatch = {
              ...nextPatch,
              stack: Math.min(9999, next.stack),
              startPosition: next.stackSize === 1 ? 1 : next.startPosition,
              ...(next.stackSize !== size ? { stackSize: next.stackSize } : {}),
            };
          }
        } catch (_) {
          /* stock hint is best-effort; submit still seeds from inventory */
        }
      } else {
        setBoxStockRows([]);
        boxStockRef.current = { key: '', box: '', rows: [] };
      }
    }
    const merged = { ...(batch.defaults || {}), ...nextPatch };
    const loc = String(merged.location || '').trim();
    if (loc && (nextPatch.startPosition != null || nextPatch.stack != null || nextPatch.stackSize != null)) {
      const size = Math.max(1, Math.trunc(Number(nextPatch.stackSize ?? defaults.stackSize)) || 1);
      const store = loadStoppedPositions();
      store[loc] = {
        stack: Math.max(1, Math.trunc(Number(nextPatch.stack ?? defaults.stack)) || 1),
        startPosition: size === 1 ? 1 : Math.max(1, Math.trunc(Number(nextPatch.startPosition ?? defaults.startPosition)) || 1),
        stackSize: size,
      };
      rememberStoppedPositions(store);
    }
    setBatch((current) => ({ ...current, defaults: { ...current.defaults, ...nextPatch } }));
    const rowPatch = batchDefaultRowPatch(nextPatch);
    const rowIds = Object.keys(rowPatch).length
      ? list.filter((row) => row.status === 'active').map((row) => row.id)
      : [];
    // Paint LANG flags immediately; server fans the same fields onto active rows.
    const tokenId = rowIds.length ? `defaults-${Date.now()}` : '';
    if (tokenId) {
      setPending((current) => {
        const next = { ...current };
        for (const id of rowIds) next[id] = [...(next[id] || []), { token: tokenId, changes: rowPatch }];
        return next;
      });
    }
    try {
      const t = await token();
      const data = await scanApi.defaults(t, batch.id, nextPatch);
      setBatch((current) => ({ ...current, ...data.batch }));
      if (data?.items?.length) dispatch({ type: 'items', items: data.items });
    } catch (err) {
      setError(err.message || 'Defaults not saved.');
    } finally {
      if (!tokenId) return;
      setPending((current) => {
        const next = { ...current };
        for (const id of rowIds) {
          next[id] = (next[id] || []).filter((p) => p.token !== tokenId);
          if (!next[id]?.length) delete next[id];
        }
        return next;
      });
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
      quantity: 1,
    });
    void remapDraftArtwork(card.id, language, card.name || '');
  }

  /** JP/KO/ID/TH/VI → japanese|korean; ZH/ZHT → chinese; western langs → western. */
  async function remapDraftArtwork(fromCardId, language, cardName = '') {
    if (!draftArtworkBucket(language)) return;
    const data = await loadVersionSet(fromCardId);
    const clip = data?.printings || [];
    let preferred = preferDraftArtwork(clip, fromCardId, language);
    if (!preferred) {
      const name = String(cardName || draft?.name || '').trim();
      if (name) {
        const nameRows = await fetchExactNameCards(name).catch(() => []);
        preferred = resolveArtworkRemap({
          clipPrintings: clip,
          namePrintings: nameRows,
          currentId: fromCardId,
          listingLanguage: language,
        });
      }
    }
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
        setDraft((current) => (current ? { ...current, quantity: 1 } : null));
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
          void remapDraftArtwork(draft.cardId, cmd.value, draft.name || '');
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
    const problem = rowProblem(focused, { intent: submitIntent });
    if ((focused.recognitionState === 'ambiguous' || focused.recognitionState === 'unmatched') && !focused.reviewed && focused.cardId) {
      patchRows([focused.id], { confirm: true }, { label: 'Confirm' });
    } else if (problem === 'no_printing') {
      setReplaceFor(focused.id);
      return;
    }
    const nextIndex = nextAttentionIndex(
      list.map((row) => (row.id === focused.id ? { ...row, reviewed: true } : row)),
      focusIndex,
      { intent: submitIntent },
    );
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
        const i = nextAttentionIndex(list, focusIndex, { intent: submitIntent });
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
        if (next) { markPick(focused, next); patchRows([focused.id], { cardId: next }, { label: 'Printing' }); }
        return;
      }
      case 'pickCandidate': {
        if (closed || !focused || draft) return;
        const cand = candidateList(focused)[cmd.index];
        if (cand) { markPick(focused, cand.cardId); patchRows([focused.id], { cardId: cand.cardId }, { label: 'Printing' }); }
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
        if (cmd.field === 'location') locationInput.current?.focus();
        else {
          // Alt Q opens the stack setup (cards per stack) behind the gear.
          stackButton.current?.focus();
          stackButton.current?.click();
        }
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
  }, [list, focusIndex, focused, closed, confirmOpen, replaceFor, helpOpen, counts.ready, selection, defaults, draft, submitIntent]);

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
    if (closed || submitIntent === 'collection') return;
    const want = list
      .filter((row) => {
        if (!row.cardId || priceTouched.current.has(row.id)) return false;
        const signature = facetSignature(row);
        if (row.pricePkn == null) return !pricesAsked.current.has(`${row.id}:${signature}`);
        return row.priceSuggested === true && suggestedFor.current.get(row.id) !== signature;
      })
      .slice(0, 12);
    if (!want.length) return;
    for (const row of want) {
      const signature = facetSignature(row);
      pricesAsked.current.add(`${row.id}:${signature}`);
      suggestedFor.current.set(row.id, signature);
    }
    let cancelled = false;
    (async () => {
      // Sold-comps slices once per printing (4 in flight, docs "once per printing").
      const queue = [...new Set(want.map((row) => String(row.cardId)))]
        .filter((id) => !slicesCache.current.has(id))
        .map((id) => () => {
          const pending = fetchCardSales(id, { slices: true })
            .then((data) => (Array.isArray(data?.slices) ? data.slices : []))
            .catch(() => []);
          slicesCache.current.set(id, pending);
          return pending;
        });
      while (queue.length) {
        await Promise.all(queue.splice(0, 4).map((run) => run()));
      }
      const cheapestIds = new Set();
      for (const row of want) {
        if (cancelled) return;
        const slices = await slicesCache.current.get(String(row.cardId));
        const pkn = suggestPriceFromSlices(slices, scanFacets(row));
        if (pkn > 0) {
          const patch = { pricePkn: Math.round(pkn), priceSuggested: true };
          lastSuggested.current.set(row.id, { signature: facetSignature(row), pkn: patch.pricePkn });
          // Fresh rows race only with an empty price; stale suggested rows overwrite.
          if (row.pricePkn == null) patch.onlyIfEmptyPrice = true;
          patchRows([row.id], patch, { record: false });
        } else {
          cheapestIds.add(String(row.cardId));
        }
      }
      // No sold comps at all → the cheapest listed price is the floor.
      if (!cheapestIds.size) return;
      const byId = await fetchCheapestPricePknMap([...cheapestIds]);
      for (const row of want) {
        if (cancelled) return;
        const pkn = byId[String(row.cardId)];
        if (pkn > 0) {
          const patch = { pricePkn: Math.round(pkn), priceSuggested: true };
          lastSuggested.current.set(row.id, { signature: facetSignature(row), pkn: patch.pricePkn });
          if (row.pricePkn == null) patch.onlyIfEmptyPrice = true;
          patchRows([row.id], patch, { record: false });
        }
      }
    })().catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, closed, submitIntent, priceRetry]);

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
      if (action === 'disconnect') intentionalDisconnect.current = true;
      const t = await token();
      const data = action === 'disconnect'
        ? await scanApi.disconnect(t, session.id)
        : action === 'pause'
          ? await scanApi.pause(t, session.id, extra)
          : await scanApi.end(t, session.id, extra);
      setSession(data.session);
      setPairing(data.pairing || null);
      if (action === 'disconnect') {
        setIdleDisconnectNote(false);
        wasPhoneConnected.current = false;
      }
      if (action === 'end') rememberActiveSession('');
    } catch (err) {
      setError(err.message);
    }
  }

  function togglePause() {
    if (session && session.status === 'connected') sessionAction('pause', !session.paused);
  }

  async function submit(targets = pendingTargets.current) {
    if (submitting || !batch?.id) return;
    const nextTargets = submitIntent === 'collection'
      ? { pokoin: true, cardtrader: false }
      : {
        pokoin: targets?.pokoin !== false,
        cardtrader: targets?.cardtrader === true,
      };
    pendingTargets.current = nextTargets;
    setSubmitting(true);
    setError('');
    try {
      const t = await token();
      const data = await scanApi.submit(t, batch.id, submitKey.current, submitIntent, nextTargets);
      setBatch((current) => ({ ...current, ...data.batch }));
      setConfirmOpen(false);
      setProblems({});
      if (data.cardtrader && data.cardtrader.ok === false) {
        setError(data.cardtrader.error || 'Listed on Pokoin; CardTrader push had errors.');
      }
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
      setError(err.message || (submitIntent === 'collection' ? 'Could not add to collection.' : 'Could not add to inventory.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function newBatch() {
    submitKey.current = newSubmitKey();
    pricesAsked.current = new Set();
    priceTouched.current = new Set();
    suggestedFor.current = new Map();
    lastSuggested.current = new Map();
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
          <h1 className="page-title">Scan cards</h1>
        </div>
        <div className={`scan-status tone-${phaseInfo.tone}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          <span>{session?.paused ? 'Paused' : phaseInfo.text}</span>
          {streamStatus === 'reconnecting' ? <span className="scan-sub">· dashboard reconnecting</span> : null}
          {counts.cards
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
          <Link className="btn ghost" to="/mypokoin">MyPokoin</Link>
        </div>
      </header>

      {error ? <p className="scan-alert" role="alert">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></p> : null}

      {waiting && !closed ? (
        <section className="scan-connect" aria-label="Connect your phone">
          <div className="scan-connect-main">
            <h2>{idleDisconnectNote ? 'Reconnect phone' : 'Connect your phone'}</h2>
            {idleDisconnectNote ? (
              <p className="scan-connect-step">Phone disconnected after 10 minutes without a scan. Pair again to continue this batch.</p>
            ) : (
              <p className="scan-connect-step">Type the code on <strong>scan.pokoin.com/connect</strong>, or scan the QR code</p>
            )}
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
          <h2>
            {batch.status === 'submitted'
              ? (batch.submitResult?.intent === 'collection'
                ? `Added ${batch.submitResult?.cards ?? counts.cards} cards to your collection`
                : `Added ${batch.submitResult?.cards ?? counts.cards} cards to Inventory`)
              : 'Batch discarded'}
          </h2>
          <p>
            {batch.submitResult?.intent === 'collection'
              ? `${batch.submitResult?.ownership ?? 0} collection records saved. None listed for sale.`
              : `${batch.submitResult?.listings ?? 0} listings are live (also added to your collection).`}
          </p>
          <div className="scan-done-actions">
            <a className="btn ghost" href={marketUrl('/mypokoin/collection')}>View collection</a>
            {batch.submitResult?.intent !== 'collection' ? (
              <Link className="btn ghost" to="/mypokoin">Open MyPokoin</Link>
            ) : null}
            <button type="button" className="btn" onClick={newBatch}>Scan another batch</button>
          </div>
        </section>
      ) : (
        <>
          <section className="scan-intent" aria-label="What do you want to do?">
            <p className="scan-intent-label">What do you want to do?</p>
            <div className="scan-intent-seg" role="group">
              <button
                type="button"
                className={submitIntent === 'list' ? 'on' : ''}
                aria-pressed={submitIntent === 'list'}
                data-testid="scan-intent-list"
                onClick={() => setSubmitIntent('list')}
              >
                List for sale
              </button>
              <button
                type="button"
                className={submitIntent === 'collection' ? 'on' : ''}
                aria-pressed={submitIntent === 'collection'}
                data-testid="scan-intent-collection"
                onClick={() => setSubmitIntent('collection')}
              >
                Add to collection
              </button>
            </div>
          </section>
          <DefaultsBar
            defaults={defaults}
            boxes={recentBoxNames}
            stackFull={stackFull}
            onChange={setDefaults}
            positionForStack={positionForStack}
            locationRef={locationInput}
            stackButtonRef={stackButton}
          />
        </>
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
          {counts.noPrice && submitIntent === 'list' ? <span className="chip warn">{counts.noPrice} need a price</span> : null}
        </span>
        {!closed ? (
          submitIntent === 'list' ? (
            <InventoryTargets
              mode="add"
              counts={counts}
              intent={submitIntent}
              disabled={!counts.ready}
              busy={submitting}
              busyLabel="Adding…"
              onSubmit={(targets) => {
                pendingTargets.current = targets;
                setConfirmOpen(true);
              }}
            />
          ) : (
            <button
              type="button"
              className="btn scan-submit"
              disabled={!counts.ready || submitting}
              onClick={() => setConfirmOpen(true)}
              title="⌘Enter"
            >
              {submitting ? 'Adding…' : submitLabel(counts, { intent: submitIntent })}
            </button>
          )
        ) : null}
      </div>

      <div
        className={`scan-queue${submitIntent === 'collection' ? ' intent-collection' : ''}`}
        role="grid"
        aria-label="Scan queue"
        tabIndex={0}
        ref={queueRef}
      >
        <div className="scan-row scan-row-head" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader" className="c-card-head">Card</span>
          <span role="columnheader">Lang</span>
          <span role="columnheader">Cond</span>
          <span role="columnheader">Finish</span>
          <span role="columnheader">Flags</span>
          <span role="columnheader">Location</span>
          <span role="columnheader">Qty</span>
          {submitIntent === 'list' ? <span role="columnheader">Price{priceCurrency !== 'PKN' ? ` · ${priceCurrency}` : ''}</span> : null}
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
            problem={problems[row.id] || rowProblem(row, { intent: submitIntent })}
            image={images[row.id]}
            closed={closed}
            hidePrice={submitIntent === 'collection'}
            priceCurrency={priceCurrency}
            slot={slots.get(row.id)}
            replacing={replaceFor === row.id}
            preferredLanguage={defaults.language}
            onPriceFocus={(rowId) => priceTouched.current.add(rowId)}
            onPriceEmptied={restoreDefaultPrice}
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
            onPick={(cardId) => { markPick(row, cardId); patchRows([row.id], { cardId }, { label: 'Printing' }); }}
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
            <h2>{submitLabel(counts, { intent: submitIntent, targets: pendingTargets.current })}?</h2>
            <p>
              {submitIntent === 'collection'
                ? `${counts.rows} cards go into your collection.`
                : pendingTargets.current.cardtrader && pendingTargets.current.pokoin
                  ? `${counts.rows} listings go live on Pokoin and CardTrader now.`
                  : pendingTargets.current.cardtrader
                    ? `${counts.rows} products go to CardTrader now.`
                    : `${counts.rows} listings go live on Pokoin now.`}
            </p>
            <div className="scan-modal-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirmOpen(false)}>Cancel (Esc)</button>
              <button type="button" className="btn" onClick={() => submit(pendingTargets.current)} disabled={submitting} autoFocus>
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
      // ECC H (~30% recovery) so a small centered Pokoin logo stays scannable.
      const qr = encodeQr(url, { ecc: 'H' });
      const logo = qrLogoLayout(qr);
      return { d: qrPath(qr), ...logo };
    } catch (_) {
      return null;
    }
  }, [url]);
  if (!path) return null;
  const logoX = path.cx - path.logo / 2;
  const logoY = path.cy - path.logo / 2;
  return (
    <figure className="scan-qr" data-connect-url={url}>
      <svg viewBox={`0 0 ${path.view} ${path.view}`} role="img" aria-label="QR code to connect your phone" shapeRendering="crispEdges">
        <rect width={path.view} height={path.view} fill="#fff" />
        <path d={path.d} fill="#000" />
        {/* White pad + Pokoin mark: ~20% logo / ~28% pad of the module field. */}
        <circle cx={path.cx} cy={path.cy} r={path.pad / 2} fill="#fff" />
        <image
          href="/home/logo.png"
          x={logoX}
          y={logoY}
          width={path.logo}
          height={path.logo}
          preserveAspectRatio="xMidYMid meet"
        />
      </svg>
      <figcaption>Scan with the phone camera.</figcaption>
    </figure>
  );
}

function boxSuggestions(boxes, draft) {
  const q = String(draft || '').trim().toLowerCase();
  const list = Array.isArray(boxes) ? boxes : [];
  if (!q) return list.slice(0, 8);
  return list.filter((name) => name.toLowerCase().includes(q)).slice(0, 8);
}

function DefaultsBar({ defaults, boxes = [], onChange, positionForStack, locationRef, stackButtonRef, stackFull = false }) {
  const [locationDraft, setLocationDraft] = useState(defaults.location);
  const [boxMenuOpen, setBoxMenuOpen] = useState(false);
  const [boxActive, setBoxActive] = useState(0);
  const [stackDraft, setStackDraft] = useState(String(defaults.stack ?? 1));
  const [posDraft, setPosDraft] = useState(String(defaults.startPosition ?? 1));
  const size = Math.max(1, Math.trunc(Number(defaults.stackSize)) || 1);
  const [sizeDraft, setSizeDraft] = useState(String(size));
  const [sizeOpen, setSizeOpen] = useState(false);
  const sizeMenuRef = useRef(null);
  useEffect(() => {
    if (!sizeOpen) return undefined;
    const onDoc = (event) => {
      if (sizeMenuRef.current && !sizeMenuRef.current.contains(event.target)) setSizeOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [sizeOpen]);
  useEffect(() => setLocationDraft(defaults.location), [defaults.location]);
  useEffect(() => setStackDraft(String(defaults.stack ?? 1)), [defaults.stack, defaults.location]);
  useEffect(() => setPosDraft(String(defaults.startPosition ?? 1)), [defaults.startPosition, defaults.location, defaults.stack]);
  useEffect(() => setSizeDraft(String(size)), [size]);
  const commitLocation = () => {
    if (locationDraft !== defaults.location) onChange({ location: locationDraft });
  };
  const suggestions = boxSuggestions(boxes, locationDraft);
  const draftBox = locationDraft.trim().toLowerCase();
  const showBoxMenu = boxMenuOpen && suggestions.length > 0 && !(
    suggestions.length === 1 && suggestions[0].toLowerCase() === draftBox
  );
  const pickBox = (name) => {
    setLocationDraft(name);
    setBoxMenuOpen(false);
    if (name !== defaults.location) onChange({ location: name });
  };
  // Giuseppe 2026-10-04: the location applies while typing — a short pause is
  // enough, no Enter. Blur and Enter still commit immediately.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (locationDraft === defaults.location) return undefined;
    const t = setTimeout(() => onChangeRef.current({ location: locationDraft }), 700);
    return () => clearTimeout(t);
  }, [locationDraft, defaults.location]);
  const commitStack = () => {
    const n = Number.parseInt(stackDraft, 10);
    if (!(n >= 1 && n <= 9999)) {
      setStackDraft(String(defaults.stack ?? 1));
      return;
    }
    if (size === 1) {
      if (n !== (defaults.stack ?? 1)) onChange({ stack: n, startPosition: 1 });
      return;
    }
    // Typing a stack that already holds cards (even the current one) continues
    // after them instead of restarting at position 1.
    const pos = (positionForStack && positionForStack(n)) || 1;
    const next = pos > size ? { stack: Math.min(9999, n + 1), startPosition: 1 } : { stack: n, startPosition: pos };
    if (next.stack !== (defaults.stack ?? 1) || next.startPosition !== (defaults.startPosition ?? 1)) onChange(next);
    else setStackDraft(String(defaults.stack ?? 1));
  };
  const commitPos = () => {
    const n = Number.parseInt(posDraft, 10);
    if (n >= 1 && n <= size && n !== (defaults.startPosition ?? 1)) onChange({ startPosition: n });
    else setPosDraft(String(defaults.startPosition ?? 1));
  };
  const commitSize = () => {
    const n = Number.parseInt(sizeDraft, 10);
    if (n >= 1 && n <= 9999) pickSize(n, { keepOpen: true });
    else setSizeDraft(String(size));
  };
  const blurOnEnter = (event) => {
    if (event.key === 'Enter') event.currentTarget.blur();
  };
  const pickSize = (nextSize, { keepOpen = true } = {}) => {
    if (!keepOpen) setSizeOpen(false);
    setSizeDraft(String(nextSize));
    if (nextSize === size) return;
    const abs = stackPosToIndex(defaults.stack ?? 1, defaults.startPosition ?? 1, size);
    const mapped = indexToStackPos(abs, nextSize);
    onChange({
      stackSize: nextSize,
      stack: mapped.stack,
      startPosition: nextSize === 1 ? 1 : mapped.position,
    });
  };
  return (
    <section className={`scan-defaults${stackFull ? ' is-stack-full' : ''}`} aria-labelledby="scan-defaults-title">
      <h2 id="scan-defaults-title" className="scan-defaults-label" title="Changing these updates every card in this batch, and the next scan. Shift + a row key changes them.">Batch defaults</h2>
      <div className="scan-defaults-row">
      {/* The TCG is the pokoin.com/{slug} prefix. Pokemon has no prefix. */}
      <label className="sd-field sd-game" title="Switch TCG — phone catalog follows this">
        <span>Game</span>
        <select
          value={gameIdFromHost()}
          onChange={(e) => {
            const next = e.target.value;
            if (next === gameIdFromHost()) return;
            setScanGameOverride(next);
            const base = gameBasename();
            const path = window.location.pathname;
            const rest = base && path.startsWith(base) ? (path.slice(base.length) || '/') : path;
            const slug = GAMES[next]?.slug || '';
            const tail = rest.startsWith('/') ? rest : `/${rest}`;
            window.location.assign(`${slug ? `/${slug}` : ''}${tail}`);
          }}
        >
          {Object.values(GAMES).map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </label>
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
      {/* Location + gear: the stack setup (cards per stack, stack, position)
          lives behind the gear, not on the bar. Every scan is one card. */}
      <div ref={sizeMenuRef} className={`sd-field grow sd-location${stackFull ? ' is-full' : ''}`}>
        <label htmlFor="scan-default-location">Location</label>
        <span className="sd-location-input">
          <input
            id="scan-default-location"
            ref={locationRef}
            value={locationDraft}
            maxLength={64}
            placeholder={suggestions[0] && !locationDraft ? suggestions[0] : ''}
            autoComplete="off"
            role="combobox"
            aria-expanded={showBoxMenu}
            aria-controls="scan-box-suggestions"
            aria-autocomplete="list"
            onChange={(e) => {
              setLocationDraft(e.target.value);
              setBoxActive(0);
              setBoxMenuOpen(true);
            }}
            onFocus={() => { setBoxMenuOpen(true); setBoxActive(0); }}
            onBlur={() => {
              setBoxMenuOpen(false);
              commitLocation();
            }}
            onKeyDown={(e) => {
              if (showBoxMenu) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setBoxActive((i) => Math.min(suggestions.length - 1, i + 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setBoxActive((i) => Math.max(0, i - 1));
                  return;
                }
                if (e.key === 'Enter' && suggestions[boxActive]) {
                  e.preventDefault();
                  pickBox(suggestions[boxActive]);
                  return;
                }
                if (e.key === 'Escape') {
                  setBoxMenuOpen(false);
                  return;
                }
              }
              blurOnEnter(e);
            }}
          />
          <button
            ref={stackButtonRef}
            type="button"
            className="sd-gear"
            aria-haspopup="dialog"
            aria-expanded={sizeOpen}
            aria-label="Stack setup"
            title={`Stack setup — ${size === 1 ? 'one card per stack' : `${size} cards per stack`}, stack ${defaults.stack ?? 1}${size > 1 ? `, next position ${defaults.startPosition ?? 1}` : ''}`}
            onClick={() => setSizeOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
            </svg>
            {size > 1 ? <b className="sd-gear-size">{size}</b> : null}
          </button>
        </span>
        {showBoxMenu ? (
          <ul id="scan-box-suggestions" className="sd-box-menu" role="listbox">
            {suggestions.map((name, i) => (
              <li key={name} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === boxActive}
                  className={i === boxActive ? 'on' : ''}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setBoxActive(i)}
                  onClick={() => pickBox(name)}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {sizeOpen ? (
          <div className="sd-stack-menu" role="dialog" aria-label="Stack setup">
            <p className="sd-stack-help">How many cards fit in one stack between two dividers. Each scan is one card; the slot counts up by itself.</p>
            <label className="sd-stack-row">
              <span>Cards per stack</span>
              <input
                inputMode="numeric"
                value={sizeDraft}
                aria-label="Cards per stack"
                onChange={(e) => setSizeDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onBlur={commitSize}
                onKeyDown={blurOnEnter}
              />
            </label>
            <div className="sd-stack-chips" role="group" aria-label="Common stack sizes">
              {STACK_SIZES.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={n === size}
                  className={n === size ? 'on' : ''}
                  onClick={() => pickSize(n)}
                >
                  {n === 1 ? '1 card' : n}
                </button>
              ))}
            </div>
            <label className="sd-stack-row">
              <span>Current stack</span>
              <input
                inputMode="numeric"
                value={stackDraft}
                aria-label="Current stack"
                onChange={(e) => setStackDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onBlur={commitStack}
                onKeyDown={blurOnEnter}
              />
            </label>
            {size > 1 ? (
              <label className="sd-stack-row">
                <span>Next position</span>
                <input
                  inputMode="numeric"
                  value={posDraft}
                  aria-label="Next position in the stack"
                  onChange={(e) => setPosDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  onBlur={commitPos}
                  onKeyDown={blurOnEnter}
                />
              </label>
            ) : null}
            <button type="button" className="btn ghost sd-stack-done" onClick={() => setSizeOpen(false)}>Done</button>
          </div>
        ) : null}
      </div>
      <label className="sd-check" title="Consecutive identical scans raise the quantity of one row">
        <input type="checkbox" checked={defaults.mergeRepeats} onChange={(e) => onChange({ mergeRepeats: e.target.checked })} />
        <span>Merge repeats</span>
      </label>
      </div>
      {stackFull ? (
        <p className="sd-stack-full-msg" role="status">Stack full — next card starts a new divider.</p>
      ) : null}
    </section>
  );
}

function thumbFor(cardId, name, imageUrl) {
  if (!cardId) return { thumb: '', hero: '' };
  const card = { id: cardId, card_id: cardId, name, imageUrl };
  try {
    return {
      thumb: imageSrc(card, 'suggest'),
      // Full-resolution leftover JPEG for the hover zoom (falls back to thumb).
      hero: imageSrc(card, 'hero'),
    };
  } catch (_) {
    return { thumb: '', hero: '' };
  }
}

function ArtworkVersionSelect({ row, closed, preferredLanguage, onPick }) {
  const [printings, setPrintings] = useState(null);
  const remapTried = useRef(new Set());
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  // The row language picks the printing. Batch language is only the fallback.
  const listingLanguage = remapListingLanguage(row.language, preferredLanguage);

  useEffect(() => {
    let cancelled = false;
    const cardId = String(row.cardId || '').trim();
    const cardName = String(row.cardName || '').trim();
    if (!cardId) {
      setPrintings(null);
      return undefined;
    }
    (async () => {
      const data = await loadVersionSet(cardId);
      if (cancelled) return;
      let rows = sortArtworkVersions(data?.printings || [], listingLanguage);
      setPrintings(rows);
      if (closed) return;
      const tryKey = `${row.id}\0${listingLanguage}\0${cardId}`;
      if (remapTried.current.has(tryKey)) return;
      remapTried.current.add(tryKey);
      let preferred = null;
      if (shouldRemapArtwork(rows, cardId, listingLanguage)) {
        preferred = preferArtworkPrinting(rows, cardId, listingLanguage);
      } else if (!currentMatchesLanguageBucket(rows, cardId, listingLanguage) && cardName) {
        // CLIP often misses a JP/CN sibling that still exists under the same
        // English name (Wondrous Patch → Nihil Zero). Exact-name fills that gap.
        const nameRows = await fetchExactNameCards(cardName).catch(() => []);
        if (cancelled) return;
        if (nameRows.length) {
          const merged = mergeArtworkCandidates(rows, nameRows);
          rows = sortArtworkVersions(merged, listingLanguage);
          setPrintings(rows);
          preferred = resolveArtworkRemap({
            clipPrintings: data?.printings || [],
            namePrintings: nameRows,
            currentId: cardId,
            listingLanguage,
          });
        }
      }
      const nextId = String(preferred?.id || preferred?.card_id || '');
      if (nextId && nextId !== cardId) onPickRef.current(nextId);
    })();
    return () => { cancelled = true; };
  }, [row.cardId, row.cardName, row.id, row.nationality, row.language, closed, listingLanguage]);

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
        nationality: preferred.nationality || cand.nationality || '',
      };
    })).then((next) => {
      if (cancelled) return;
      const seen = new Set();
      const unique = next.filter((c) => {
        const id = String(c.cardId || '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      setMapped(candidatesForPrintFamily(unique, lang));
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
  row, index, focused, selected, problem, image, closed, slot, replacing,
  preferredLanguage, hidePrice = false, priceCurrency = 'PKN',
  onFocus, onPatch, onPriceFocus, onPriceEmptied, onPick, onRemove, onReplaceDone,
}) {
  const stateLabel = row.status === 'submitted'
    ? (hidePrice ? 'Collected' : 'Listed')
    : problem
      ? PROBLEM_LABEL[problem]
      : row.recognitionState === 'manual' ? 'Manual' : row.reviewed && row.recognitionState !== 'matched' ? 'Checked' : 'Matched';
  const tone = row.status === 'submitted' ? 'ok' : problem === 'no_printing' ? 'bad' : problem ? 'warn' : 'ok';
  const showCandidates = !closed && (row.recognitionState === 'ambiguous' || row.recognitionState === 'unmatched');
  const unidentified = !closed && !row.cardId;
  // Full LANG list — expansion remaps when the language implies another print.
  // Card desk still restricts via languagesForNationality.
  const langValue = LANGUAGES.includes(row.language) ? row.language : (row.language || 'EN');
  const thumbArt = thumbFor(row.cardId, row.cardName, row.imageUrl);
  const thumb = thumbArt.thumb;
  const zoomSrc = thumbArt.hero || thumbArt.thumb;
  const remapLang = remapListingLanguage(row.language, preferredLanguage);
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
      <span className="c-identity">
      <span
        className="c-art"
        draggable={Boolean(row.cardId || row.cardName)}
        onDragStart={(event) => {
          if (!row.cardId && !row.cardName) return;
          writeListingDrag(event, cardReference({
            id: row.cardId,
            name: row.cardName,
            imageUrl: row.imageUrl || zoomSrc || thumb,
            canonicalPath: row.cardId ? `/marketplace/en/cards/${row.cardId}` : '',
          }));
        }}
      >
        {showCandidates && image && image !== 'none' ? <img className="scan-shot" src={image} alt="Scanned card" /> : null}
        {thumb ? (
          <ThumbZoom src={zoomSrc} full={Boolean(thumbArt.hero)} alt={row.cardName || ''}>
            <img src={thumb} alt="" loading="lazy" />
          </ThumbZoom>
        ) : <span className="art-empty" />}
      </span>
      <span className="c-card">
        {unidentified ? (
          <ReplacePrinting
            inline
            onPick={(id) => { onPick(id); onReplaceDone(); }}
            onClose={onReplaceDone}
            seed=""
          />
        ) : (
          <strong>{row.cardName || (row.cardId ? `#${row.cardId}` : 'Not identified')}</strong>
        )}
        <ArtworkVersionSelect
          row={row}
          closed={closed}
          preferredLanguage={remapLang}
          onPick={onPick}
        />
        {showCandidates ? (
          <CandidateAlts row={row} preferredLanguage={remapLang} onPick={onPick} />
        ) : null}
        {replacing && !unidentified ? <ReplacePrinting onPick={(id) => { onPick(id); onReplaceDone(); }} onClose={onReplaceDone} seed={row.cardName} /> : null}
      </span>
      </span>
      <span className="c-lang">
        {closed ? (
          <img className="scan-lang-flag" src={flagSrc(langValue)} alt="" title={langValue} width="18" height="18" />
        ) : (
          <label className="scan-icon-select" title={langValue}>
            <img className="scan-lang-flag" src={flagSrc(langValue)} alt="" width="18" height="18" />
            <select
              value={langValue}
              aria-label={`Language ${langValue}`}
              onChange={(e) => onPatch({ language: e.target.value })}
              tabIndex={-1}
            >
              {(LANGUAGES.includes(langValue) ? LANGUAGES : [langValue, ...LANGUAGES]).map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
          </label>
        )}
      </span>
      <span className="c-cond">
        {closed ? (
          <img className="scan-cond-chip" src={conditionChipSrc(row.condition)} alt="" title={row.condition} width="28" height="20" />
        ) : (
          <label className="scan-icon-select" title={row.condition}>
            <img className="scan-cond-chip" src={conditionChipSrc(row.condition)} alt="" width="28" height="20" />
            <select
              value={row.condition}
              aria-label={`Condition ${row.condition}`}
              onChange={(e) => onPatch({ condition: e.target.value })}
              tabIndex={-1}
            >
              {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
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
      <span className="c-loc" title={slot ? `Position ${slot.start}${slot.end > slot.start ? `–${slot.end}` : ''} inside the box` : undefined}>
        {closed ? (
          <>
            {row.location}
            <b className="loc-slot">{slotText(slot)}</b>
          </>
        ) : (
          <>
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
            {row.location ? <b className="loc-slot">{slotText(slot)}</b> : null}
          </>
        )}
      </span>
      <span className="c-qty">
        {closed ? row.quantity : (
          <input
            inputMode="numeric"
            aria-label={`Quantity for ${row.cardName || `row ${index + 1}`}`}
            title="Cards in this row (1–99)"
            tabIndex={-1}
            maxLength={2}
            key={`${row.id}:${row.quantity}`}
            defaultValue={row.quantity}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const commit = quantityFieldCommit(row, e.currentTarget.value);
              if (commit.action === 'set') onPatch({ quantity: commit.quantity });
              else e.currentTarget.value = String(row.quantity);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        )}
      </span>
      {hidePrice ? null : (
      <span className={`c-price${row.priceSuggested ? ' suggested' : ''}`}>
        {closed ? formatSellerPrice(row.pricePkn, priceCurrency) : (
          <input
            inputMode="decimal"
            tabIndex={-1}
            key={`${row.id}:${row.pricePkn}:${priceCurrency}`}
            defaultValue={priceInputFromPkn(row.pricePkn, priceCurrency)}
            // While a suggested price is cleared for typing, it stays visible
            // as the placeholder: leaving the field empty keeps it.
            placeholder={row.priceSuggested && row.pricePkn != null ? priceInputFromPkn(row.pricePkn, priceCurrency) : priceCurrency}
            onFocus={(e) => {
              // Clicking in is the only thing that empties a suggested price;
              // switching versions re-suggests instead.
              onPriceFocus?.(row.id);
              if (row.priceSuggested) e.target.value = '';
            }}
            onBlur={(e) => {
              const commit = priceFieldCommit(row, e.target.value, priceCurrency);
              if (commit.action === 'set') {
                onPatch({ pricePkn: commit.pricePkn, ...(row.priceSuggested ? { priceSuggested: false } : {}) });
                return;
              }
              if (commit.action === 'default') onPriceEmptied?.(row);
              e.target.value = priceInputFromPkn(row.pricePkn, priceCurrency);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        )}
      </span>
      )}
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

function ReplacePrinting({ onPick, onClose, seed, inline = false }) {
  const [query, setQuery] = useState(seed || '');
  const input = useRef(null);
  const { results, active, setActive } = useScanPrintingSuggest(query);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <span className={inline ? 'scan-replace inline' : 'scan-replace'} role="dialog" aria-label="Replace printing">
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
