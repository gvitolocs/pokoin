import { createMemo, createSignal, flush, For, onSettled, Show, untrack } from 'solid-js';
import { useLocation } from '@solidjs/router';
import {
  fetchCardSales,
  fetchCheapestPricePknMap,
  fetchExactNameCards,
  fetchSellerListings,
  imageSrc,
} from '@market/api.js';
import {
  continueBoxCursor,
  listingBox,
  liveInventoryListings,
  nextPositionInStack,
  occupiedAbsForScanBoxes,
  recentBoxes,
} from '@market/inventory-listings.js';
import { fetchScanImage, rememberActiveSession, scanApi, streamUrl } from '@market/scan-api.js';
import {
  batchDefaultRowPatch,
  draftArtworkBucket,
  listingLanguageForPrint,
  preferDraftArtwork,
  remapListingLanguage,
  resolveArtworkRemap,
} from '@market/scan-artwork-versions.js';
import {
  applyItems,
  batchCounts,
  boxSlots,
  candidateList,
  createPatchChain,
  cycleFinish,
  DEFAULTS,
  frameEvents,
  nextAttentionIndex,
  nextBoxPositions,
  newSubmitKey,
  phaseText,
  queueRows,
  rowProblem,
  sessionPhase,
  slotFilledStack,
  stepCandidate,
  submitLabel,
  typeQuantity,
} from '@market/scan-model.js';
import { shortcutFor } from '@market/scan-shortcuts.js';
import { facetSignature, scanFacets, suggestPriceFromSlices } from '@market/scan-pricing.js';
import { connectScanStream } from '@market/scan-stream.js';
import { gameIdFromHost } from '@market/game.js';
import { marketUrl } from '@market/punchouts.js';
import '@market/scan-desk.css';
import InventoryTargets from '../components/desk/InventoryTargets.jsx';
import { accountProfile } from '../stores/account.js';
import { authUser, getBearer, signedIn } from '../stores/auth.js';
import { sellerCurrency } from '../stores/buyer.js';
import { AutoFocusButton, DefaultsBar, HelpOverlay, PerfPanel, QrBlock } from './scan-desk/bars.jsx';
import { ManualAddBar, QueueRow } from './scan-desk/rows.jsx';
import {
  FIELD_LABEL,
  loadStoppedPositions,
  loadVersionSet,
  perfSink,
  rememberStoppedPositions,
  versionSetCache,
} from './scan-desk/version-sets.js';
import { watch } from './scan-desk/watch.js';
import { RequireSignIn } from './tools/auth-gate.jsx';
import { usePageTitle } from './tools/board.jsx';

/**
 * Scan Connect desk (market/src/pages/ScanDesk.jsx): the phone pairs with a
 * PIN/QR, scans stream into the queue over SSE, and the seller fixes
 * printings, prices and box slots with PowerTools shortcuts before adding the
 * batch to inventory or the collection. Behaviour follows the React desk
 * line by line; `watch` stands in for useEffect with explicit deps.
 */
function ScanDeskDesk() {
  const location = useLocation();
  const uid = () => authUser()?.uid || accountProfile()?.uid || '';
  // Sellers who opted out of PKN payments price the queue in local currency.
  const priceCurrency = () => sellerCurrency();
  const [session, setSession] = createSignal(null);
  const [batch, setBatch] = createSignal(null);
  const [pairing, setPairing] = createSignal(null);
  const [idleDisconnectNote, setIdleDisconnectNote] = createSignal(false);
  const [serverOffset, setServerOffset] = createSignal(0);
  const [rows, setRows] = createSignal({});
  const [pending, setPending] = createSignal({});
  const [streamStatus, setStreamStatus] = createSignal('connecting');
  const [error, setError] = createSignal('');
  const [focusId, setFocusId] = createSignal('');
  const [selection, setSelection] = createSignal(new Set());
  const [toasts, setToasts] = createSignal([]);
  const [stackFull, setStackFull] = createSignal(false);
  let stackFullTimer = null;
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [replaceFor, setReplaceFor] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [problems, setProblems] = createSignal({});
  /** Finalize intent: list → listings+ownership; collection → ownership only. */
  const [submitIntent, setSubmitIntent] = createSignal('list');
  const [now, setNow] = createSignal(Date.now());
  const [images, setImages] = createSignal({});
  // Bumped to re-run the price suggestion effect for a row whose price field was emptied.
  const [priceRetry, setPriceRetry] = createSignal(0);
  /** PowerTools single-card draft: printing picked, Qty focused, hotkeys edit, Enter creates. */
  const [draft, setDraft] = createSignal(null);
  const [boxStockRows, setBoxStockRows] = createSignal([]);
  const [recentBoxNames, setRecentBoxNames] = createSignal([]);
  let qtyBuffer = { id: '', buffer: '', at: 0 };
  const undoStack = [];
  let redoStack = [];
  let pricesAsked = new Set();
  const slicesCache = new Map();
  let priceTouched = new Set();
  let suggestedFor = new Map();
  // rowId → { signature, pkn }: the last default price, restored when the
  // price field is left empty.
  let lastSuggested = new Map();
  const patchChain = createPatchChain();
  const remapTried = new Set();
  let queueEl = null;
  let locationInput = null;
  let stackButton = null;
  let draftQtyInput = null;
  let addSearchInput = null;
  let submitKey = newSubmitKey();
  let pendingTargets = { pokoin: true, cardtrader: false };
  let followTail = true;
  let intentionalDisconnect = false;
  let wasPhoneConnected = false;

  const dispatch = (action) => {
    setRows((state) => (action.type === 'reset' ? applyItems({}, action.items) : applyItems(state, action.items)));
  };

  // ---------------------------------------------------------------- session

  const token = (force = false) => getBearer(force);

  async function startSession(batchId) {
    setError('');
    const perf = perfSink();
    const t0 = performance.now();
    try {
      const t = await token();
      const tokenMs = Math.round(performance.now() - t0);
      const t1 = performance.now();
      const data = await scanApi.start(t, batchId);
      const startMs = Math.round(performance.now() - t1);
      // Paint the PIN/QR tile before the items snapshot fetch (React flushSync).
      setSession(() => data.session);
      setBatch(() => data.batch);
      setPairing(() => data.pairing);
      setServerOffset(Number(data.serverTime) - Date.now());
      flush();
      rememberActiveSession(data.session?.id || '');
      perf.push({ kind: 'desk-start', tokenMs, startMs, pairing: Boolean(data.pairing), at: Date.now() });
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
  }

  watch(() => [signedIn(), uid()], ([on, id]) => {
    if (!on || !id) return;
    // A different account in this tab never sees the previous seller's batch.
    setSession(null);
    setBatch(null);
    setPairing(null);
    dispatch({ type: 'reset', items: [] });
    startSession();
  });

  onSettled(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  });

  // ---------------------------------------------------------------- stream

  watch(() => [batch()?.id], ([batchId]) => {
    if (!batchId) return undefined;
    const perf = perfSink();
    const handle = connectScanStream({
      batchId,
      urlFor: (id, cursor) => streamUrl(id, cursor),
      getToken: token,
      onStatus: setStreamStatus,
      onEvent: (name, data) => {
        if (name === 'hello') {
          if (data.session) setSession(() => data.session);
          if (data.batch) setBatch((current) => ({ ...current, ...data.batch }));
          setServerOffset(Number(data.serverTime) - Date.now());
        } else if (name === 'items') {
          const arrivedAt = Date.now();
          const offset = untrack(serverOffset);
          const events = frameEvents(untrack(rows), data.items, { serverNowMs: arrivedAt + offset });
          dispatch({ type: 'items', items: data.items });
          for (const event of events) {
            if (event.type === 'merged') {
              pushToast({ id: event.mergedId, text: `Qty ${event.from} → ${event.to}`, itemId: event.mergedId });
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
              const arrivedServer = arrivedAt + offset;
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
                  captureToRenderMs: Math.max(0, Date.now() + untrack(serverOffset) - captured),
                  at: Date.now(),
                });
              });
            }
            if (event.type === 'added' && followTail) {
              setFocusId(event.id);
            }
          }
        } else if (name === 'session') {
          const next = data.session;
          if (wasPhoneConnected && next?.status === 'waiting' && !intentionalDisconnect) {
            setIdleDisconnectNote(true);
          }
          if (next?.status === 'connected') {
            setIdleDisconnectNote(false);
            intentionalDisconnect = false;
          }
          wasPhoneConnected = next?.status === 'connected';
          setSession(() => next);
          if (data.serverTime) setServerOffset(Number(data.serverTime) - Date.now());
          if (next?.status === 'waiting') {
            token().then((t) => scanApi.session(t, next.id)).then((res) => {
              setPairing(() => res.pairing);
              if (res.justIdleDisconnected) setIdleDisconnectNote(true);
            }).catch(() => {});
          }
        } else if (name === 'batch') {
          setBatch((current) => ({ ...current, ...data.batch }));
        }
      },
    });
    return () => handle.stop();
  });

  // ---------------------------------------------------------------- derived

  const displayRows = createMemo(() => {
    const merged = {};
    const waiting = pending();
    for (const [id, row] of Object.entries(rows())) {
      merged[id] = waiting[id]?.length ? Object.assign({}, row, ...waiting[id].map((p) => p.changes)) : row;
    }
    return merged;
  });
  const list = createMemo(() => queueRows(displayRows()));
  const occupiedAbs = createMemo(() => occupiedAbsForScanBoxes(list(), boxStockRows()));
  const slots = createMemo(() => boxSlots(list(), { occupiedAbs: occupiedAbs() }));
  const counts = createMemo(() => batchCounts(displayRows(), { intent: submitIntent() }));
  const phaseInfo = createMemo(() => phaseText(sessionPhase(session(), now(), serverOffset()), session()));
  const defaults = () => batch()?.defaults || DEFAULTS;
  const closed = () => Boolean(batch() && batch().status !== 'open');
  const stockUid = uid;

  // Push Game picker (dashboard localStorage override) into batch defaults once a batch exists.
  watch(() => [batch()?.id, closed()], ([batchId, isClosed]) => {
    if (!batchId || isClosed) return;
    const id = gameIdFromHost();
    if ((defaults().game || 'pokemon') === id) return;
    setDefaults({ game: id });
  });
  const focusIndex = createMemo(() => list().findIndex((row) => row.id === focusId()));
  const focused = () => (focusIndex() >= 0 ? list()[focusIndex()] : null);

  watch(() => [focusId(), list()], ([id, rowsNow]) => {
    if (!id && rowsNow.length) setFocusId(rowsNow[rowsNow.length - 1].id);
  });

  watch(() => [focusId()], ([id]) => {
    if (!id || !queueEl) return;
    const el = queueEl.querySelector(`[data-row="${id}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  });

  // The queue is part of the page. Follow new scans only while the seller
  // is already at the bottom of that page.
  onSettled(() => {
    const onScroll = () => {
      if (!queueEl) return;
      const rect = queueEl.getBoundingClientRect();
      followTail = rect.bottom - window.innerHeight < 80;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  });

  // Keep where the seller stopped per box (stack + position) so the next
  // session can resume at the same divider. An empty batch has not placed a
  // card yet: writing its pristine 1·1 here erased the stop before the resume
  // effect below could read it. Explicit Stack/Position edits are remembered
  // in setDefaults.
  watch(
    () => [list(), occupiedAbs(), defaults().location, defaults().startPosition, defaults().stack, defaults().stackSize],
    ([rowsNow, occupied, , , , stackSize]) => {
      const size = Math.max(1, Math.trunc(Number(stackSize)) || 1);
      if (!rowsNow.length) return;
      const next = nextBoxPositions(rowsNow, { occupiedAbs: occupied });
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
    },
  );

  // Advance Stack / Position as cards land, and flash when a divider fills.
  let prevListLen = 0;
  watch(() => [list(), occupiedAbs()], ([rowsNow, occupied]) => {
    const d = defaults();
    const loc = String(d.location || '').trim();
    const len = rowsNow.length;
    const grew = len > prevListLen;
    prevListLen = len;
    if (!loc || !grew || !len) return;
    const size = Math.max(1, Math.trunc(Number(d.stackSize)) || 1);
    const slotMap = boxSlots(rowsNow);
    const last = rowsNow[rowsNow.length - 1];
    const slot = last && slotMap.get(last.id);
    // Size 1 = one card per divider: nothing "fills", so never flash/toast.
    if (size > 1 && slot && slotFilledStack(slot)) {
      setStackFull(true);
      if (stackFullTimer) clearTimeout(stackFullTimer);
      stackFullTimer = setTimeout(() => setStackFull(false), 2800);
      pushToast({ text: `Stack ${slot.stack} full — next divider`, ms: 3200 });
    } else if (size === 1 && stackFull()) {
      setStackFull(false);
    }
    const next = nextBoxPositions(rowsNow, { occupiedAbs: occupied }).get(loc);
    if (!next) return;
    const patch = {};
    if (next.stack !== (d.stack ?? 1)) patch.stack = next.stack;
    if (next.startPosition !== (d.startPosition ?? 1)) patch.startPosition = next.startPosition;
    if (Object.keys(patch).length) setDefaults(patch);
  });

  // A batch continues after the last card added to the box. That inventory
  // slot wins even when a saved cursor ran ahead into an empty stack.
  let boxStock = { key: '', box: '', rows: [] };
  watch(
    () => [batch()?.id, defaults().location, closed(), stockUid()],
    ([batchId, location, isClosed, sellerUid]) => {
      const loc = String(location || '').trim();
      if (isClosed || !batchId || !loc || !sellerUid) return undefined;
      const box = listingBox(loc);
      const key = `${batchId}|${box}`;
      if (boxStock.key === key) return undefined;
      boxStock = { key, box, rows: [] };
      let cancelled = false;
      (async () => {
        try {
          const data = await fetchSellerListings(sellerUid, await getBearer(), { limit: 1000 });
          if (cancelled) return;
          const stock = liveInventoryListings(data.listings || data.items || []);
          boxStock = { key, box, rows: stock };
          setBoxStockRows(stock);
          const d = defaults();
          if (listingBox(String(d.location || '').trim()) !== box) return;
          const size = Math.max(1, Math.trunc(Number(d.stackSize)) || 1);
          const next = continueBoxCursor(stock, box, size);
          if (!next) return;
          // Inventory is the cursor, including when a saved stop ran ahead of
          // the last card actually added (that stop opened an empty stack).
          if (
            next.stack !== (d.stack ?? 1)
            || (next.stackSize === 1 ? 1 : next.startPosition) !== (d.startPosition ?? 1)
            || next.stackSize !== size
          ) {
            setDefaults({
              stack: Math.min(9999, next.stack),
              startPosition: next.stackSize === 1 ? 1 : next.startPosition,
              ...(next.stackSize !== size ? { stackSize: next.stackSize } : {}),
            });
          }
        } catch (_) {
          boxStock = { key: '', box: '', rows: [] }; // retry on the next location change
          setBoxStockRows([]);
        }
      })();
      return () => { cancelled = true; };
    },
  );

  // An empty location suggests the box on the seller's newest listing.
  // One shot per batch: clearing the field afterwards stays cleared.
  let locationSeeded = '';
  watch(
    () => [batch()?.id, defaults().location, closed(), stockUid()],
    ([batchId, location, isClosed, sellerUid]) => {
      if (isClosed || !batchId || !sellerUid) return undefined;
      if (String(location || '').trim()) {
        locationSeeded = batchId;
        return undefined;
      }
      if (locationSeeded === batchId) return undefined;
      let cancelled = false;
      (async () => {
        try {
          const data = await fetchSellerListings(sellerUid, await getBearer(), { limit: 200 });
          if (cancelled || locationSeeded === batchId) return;
          const stock = liveInventoryListings(data.listings || data.items || []);
          const boxes = recentBoxes(stock);
          setRecentBoxNames(boxes);
          setBoxStockRows((current) => (current.length ? current : stock));
          const last = boxes[0];
          if (!last || String(defaults().location || '').trim()) return;
          locationSeeded = batchId;
          setDefaults({ location: last });
        } catch (_) { /* the field stays empty; the seller can still type a box */ }
      })();
      return () => { cancelled = true; };
    },
  );

  /** Next free position when the seller types a stack: stock in the box plus this batch. */
  function positionForStack(stack) {
    const d = defaults();
    const loc = String(d.location || '').trim();
    const size = Math.max(1, Math.trunc(Number(d.stackSize)) || 1);
    if (!loc || size === 1) return null;
    const box = listingBox(loc);
    const stock = boxStock.box === box ? boxStock.rows : [];
    let next = nextPositionInStack(stock, box, stack, size) || 1;
    const slotMap = slots();
    for (const row of list()) {
      if (listingBox(String(row.location || '').trim()) !== box) continue;
      const slot = slotMap.get(row.id);
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
      undoStack.push({ label: toast.text, undo: () => runApi((t) => scanApi.unmerge(t, toast.itemId, batch()?.id)) });
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
    const lang = remapListingLanguage(row.language, defaults().language);
    remapTried.add(`${row.id}\0${lang}\0${String(nextId)}`);
  }

  /** An emptied price field falls back to the default price, never "Needs a price". */
  function restoreDefaultPrice(row) {
    priceTouched.delete(row.id);
    if (row.priceSuggested && row.pricePkn != null) return;
    const signature = facetSignature(row);
    const last = lastSuggested.get(row.id);
    if (last?.signature === signature) {
      patchRows([row.id], { pricePkn: last.pkn, priceSuggested: true }, { label: 'Price' });
      return;
    }
    // No default known for this printing yet: clear it so the price effect asks again.
    pricesAsked.delete(`${row.id}:${signature}`);
    suggestedFor.delete(row.id);
    if (row.pricePkn != null) {
      patchRows([row.id], { pricePkn: null, priceSuggested: false }, { label: 'Price' });
    } else {
      setPriceRetry((n) => n + 1);
    }
  }

  async function patchRows(ids, changes, { record = true, label = '' } = {}) {
    // Prefer displayRows (includes in-flight pending) so a version remap right
    // after Batch Defaults → IT does not stomp language back to stale EN.
    const source = untrack(displayRows);
    const committed = untrack(rows);
    const targets = ids.map((id) => source[id] || committed[id]).filter((row) => row && row.status === 'active');
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
      const preferredLang = changes.language || targets[0].language || untrack(defaults).language || 'EN';
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
      undoStack.push({
        label: label || 'Edit',
        undo: () => Promise.all(before.map(([id, prev]) => (Object.keys(prev).length ? patchRows([id], prev, { record: false }) : null))),
        redo: () => patchRows(ids, changes, { record: false }),
      });
      redoStack = [];
    }
    try {
      // Serialize per row: the version-switch patch (which clears the stale
      // price) must land before the follow-up price suggestion is sent, or the
      // server applies them out of order and wipes the fresh suggestion.
      await Promise.all(targets.map((row) => patchChain(
        row.id,
        () => runApi((t) => scanApi.patch(t, row.id, changes, batch()?.id)),
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
  watch(() => [batch()?.id, batch()?.defaults?.quantity, closed()], ([batchId, quantity, isClosed]) => {
    if (!batchId || isClosed) return;
    if ((Math.trunc(Number(quantity)) || 1) !== 1) setDefaults({ quantity: 1 });
  });

  async function setDefaults(patch) {
    const current = untrack(batch);
    if (!current?.id) return;
    const d = untrack(defaults);
    const rowsNow = untrack(list);
    const sellerUid = untrack(stockUid);
    let nextPatch = { ...patch };
    // Typing a box after cards were scanned empty: look at live stock in that
    // box and resume stack/position after the last taken slot before rows get
    // the bare location (otherwise every row anchors at ·1 and collides).
    if (Object.prototype.hasOwnProperty.call(patch, 'location') && sellerUid) {
      const loc = String(patch.location || '').trim();
      if (loc) {
        const box = listingBox(loc);
        const size = Math.max(1, Math.trunc(Number(patch.stackSize ?? d.stackSize)) || 1);
        try {
          const data = await fetchSellerListings(sellerUid, await getBearer(), { limit: 1000 });
          const stock = liveInventoryListings(data.listings || data.items || []);
          boxStock = { key: `${current.id}|${box}`, box, rows: stock };
          setBoxStockRows(stock);
          setRecentBoxNames(recentBoxes(stock));
          const next = continueBoxCursor(stock, box, size);
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
        boxStock = { key: '', box: '', rows: [] };
      }
    }
    const merged = { ...(current.defaults || {}), ...nextPatch };
    const loc = String(merged.location || '').trim();
    if (loc && (nextPatch.startPosition != null || nextPatch.stack != null || nextPatch.stackSize != null)) {
      const size = Math.max(1, Math.trunc(Number(nextPatch.stackSize ?? d.stackSize)) || 1);
      const store = loadStoppedPositions();
      store[loc] = {
        stack: Math.max(1, Math.trunc(Number(nextPatch.stack ?? d.stack)) || 1),
        startPosition: size === 1 ? 1 : Math.max(1, Math.trunc(Number(nextPatch.startPosition ?? d.startPosition)) || 1),
        stackSize: size,
      };
      rememberStoppedPositions(store);
    }
    setBatch((prev) => ({ ...prev, defaults: { ...prev.defaults, ...nextPatch } }));
    const rowPatch = batchDefaultRowPatch(nextPatch);
    const rowIds = Object.keys(rowPatch).length
      ? rowsNow.filter((row) => row.status === 'active').map((row) => row.id)
      : [];
    // Paint LANG flags immediately; server fans the same fields onto active rows.
    const tokenId = rowIds.length ? `defaults-${Date.now()}` : '';
    if (tokenId) {
      setPending((prev) => {
        const next = { ...prev };
        for (const id of rowIds) next[id] = [...(next[id] || []), { token: tokenId, changes: rowPatch }];
        return next;
      });
    }
    try {
      const t = await token();
      const data = await scanApi.defaults(t, current.id, nextPatch);
      setBatch((prev) => ({ ...prev, ...data.batch }));
      if (data?.items?.length) dispatch({ type: 'items', items: data.items });
    } catch (err) {
      setError(err.message || 'Defaults not saved.');
    } finally {
      if (tokenId) {
        setPending((prev) => {
          const next = { ...prev };
          for (const id of rowIds) {
            next[id] = (next[id] || []).filter((p) => p.token !== tokenId);
            if (!next[id]?.length) delete next[id];
          }
          return next;
        });
      }
    }
  }

  async function undo() {
    const entry = undoStack.pop();
    if (!entry) return;
    try {
      await entry.undo();
      if (entry.redo) redoStack.push(entry);
    } catch (err) {
      setError(err.message || 'Undo failed.');
    }
  }

  async function redo() {
    const entry = redoStack.pop();
    if (!entry?.redo) return;
    await entry.redo();
    undoStack.push(entry);
  }

  // ---------------------------------------------------------------- row commands

  const targetIds = () => {
    const picked = selection();
    if (picked.size) return [...picked];
    const row = focused();
    return row ? [row.id] : [];
  };

  function move(delta) {
    const rowsNow = list();
    if (!rowsNow.length) return;
    const index = focusIndex();
    const next = Math.max(0, Math.min(rowsNow.length - 1, (index < 0 ? rowsNow.length - 1 : index) + delta));
    followTail = next === rowsNow.length - 1;
    setFocusId(rowsNow[next].id);
    setSelection(new Set());
  }

  async function removeRows(ids) {
    try {
      for (const id of ids) {
        await runApi((t) => scanApi.remove(t, id, batch()?.id));
      }
    } catch (err) {
      setError(err.message || 'Row not removed.');
      return;
    }
    undoStack.push({
      label: 'Remove',
      undo: () => Promise.all(ids.map((id) => runApi((t) => scanApi.restore(t, id, batch()?.id)))),
      redo: () => removeRows(ids),
    });
    pushToast({
      text: `${ids.length} removed`,
      action: 'Undo',
      run: () => Promise.all(ids.map((id) => runApi((t) => scanApi.restore(t, id, batch()?.id)))),
    });
  }

  async function duplicate(row) {
    let data;
    try {
      data = await runApi((t) => scanApi.duplicate(t, row.id, batch()?.id));
    } catch (err) {
      setError(err.message || 'Row not copied.');
      return;
    }
    const copy = data?.items?.[0];
    if (copy) {
      setFocusId(copy.id);
      undoStack.push({ label: 'Copy', undo: () => runApi((t) => scanApi.remove(t, copy.id, batch()?.id)) });
    }
  }

  const focusAddSearch = () => requestAnimationFrame(() => addSearchInput?.focus());
  const focusDraftQty = () => {
    draftQtyInput?.focus();
    draftQtyInput?.select();
  };

  /** PowerTools single-card: pick a printing → draft with Batch Defaults; Qty autofocus. */
  function startDraft(card) {
    if (!card?.id || closed()) return;
    const d = defaults();
    const language = d.language;
    setDraft({
      cardId: card.id,
      name: card.name || '',
      set: card.set || '',
      number: card.number || '',
      image: card.image || '',
      language,
      condition: d.condition,
      foilState: d.foilState,
      firstEdition: d.firstEdition,
      signed: d.signed,
      altered: d.altered,
      location: d.location,
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
      const name = String(cardName || untrack(draft)?.name || '').trim();
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

  watch(() => [draft()?.cardId], () => {
    if (!untrack(draft)) return undefined;
    const id = requestAnimationFrame(focusDraftQty);
    return () => cancelAnimationFrame(id);
  });

  async function commitDraft({ keep = false } = {}) {
    const current = draft();
    const b = batch();
    if (!current || !b?.id || closed()) return;
    const qty = Math.max(1, Math.min(99, Number(current.quantity) || 1));
    try {
      const data = await runApi((t) => scanApi.add(t, b.id, {
        cardId: current.cardId,
        language: current.language,
        condition: current.condition,
        foilState: current.foilState,
        firstEdition: current.firstEdition,
        signed: current.signed,
        altered: current.altered,
        location: current.location,
        quantity: qty,
      }));
      const item = data?.items?.[0];
      if (item) {
        followTail = true;
        setFocusId(item.id);
        undoStack.push({ label: 'Add', undo: () => runApi((t) => scanApi.remove(t, item.id, batch()?.id)) });
        redoStack = [];
      }
      if (keep) {
        // Create & copy (PT `c`): stay on the same printing for another identity.
        setDraft((prev) => (prev ? { ...prev, quantity: 1 } : null));
        requestAnimationFrame(focusDraftQty);
      } else {
        setDraft(null);
        focusAddSearch();
      }
    } catch (err) {
      setError(err.message || 'Could not add card.');
    }
  }

  function applyAttribute(cmd) {
    const d = defaults();
    if (cmd.target === 'defaults') {
      if (cmd.command === 'set') return setDefaults({ [cmd.field]: cmd.value });
      if (cmd.command === 'toggle') {
        if (cmd.field === 'reverse') return setDefaults({ foilState: d.foilState === 'reverse' ? 'standard' : 'reverse' });
        return setDefaults({ [cmd.field]: !d[cmd.field] });
      }
      if (cmd.command === 'cycleFinish') return setDefaults({ foilState: cycleFinish(d.foilState) });
      return null;
    }
    if (cmd.target === 'draft') {
      const current = draft();
      if (!current) return null;
      if (cmd.command === 'set') {
        setDraft((prev) => (prev ? { ...prev, [cmd.field]: cmd.value } : null));
        if (cmd.field === 'language' && current.cardId) {
          void remapDraftArtwork(current.cardId, cmd.value, current.name || '');
        }
        return null;
      }
      if (cmd.command === 'toggle') {
        if (cmd.field === 'reverse') {
          setDraft((prev) => (prev ? { ...prev, foilState: prev.foilState === 'reverse' ? 'standard' : 'reverse' } : null));
          return null;
        }
        setDraft((prev) => (prev ? { ...prev, [cmd.field]: !prev[cmd.field] } : null));
        return null;
      }
      if (cmd.command === 'cycleFinish') {
        setDraft((prev) => (prev ? { ...prev, foilState: cycleFinish(prev.foilState) } : null));
        return null;
      }
      return null;
    }
    const ids = targetIds();
    const row = focused();
    if (!ids.length || !row) return null;
    if (cmd.command === 'set') return patchRows(ids, { [cmd.field]: cmd.value }, { label: cmd.value });
    if (cmd.command === 'toggle') {
      if (cmd.field === 'reverse') {
        return patchRows(ids, { foilState: row.foilState === 'reverse' ? 'standard' : 'reverse' }, { label: 'Reverse' });
      }
      return patchRows(ids, { [cmd.field]: !row[cmd.field] }, { label: FIELD_LABEL[cmd.field] });
    }
    if (cmd.command === 'cycleFinish') return patchRows(ids, { foilState: cycleFinish(row.foilState) }, { label: 'Finish' });
    return null;
  }

  function confirmFocused() {
    const row = focused();
    if (!row) return;
    const intent = submitIntent();
    const problem = rowProblem(row, { intent });
    if ((row.recognitionState === 'ambiguous' || row.recognitionState === 'unmatched') && !row.reviewed && row.cardId) {
      patchRows([row.id], { confirm: true }, { label: 'Confirm' });
    } else if (problem === 'no_printing') {
      setReplaceFor(row.id);
      return;
    }
    const rowsNow = list();
    const index = focusIndex();
    const nextIndex = nextAttentionIndex(
      rowsNow.map((item) => (item.id === row.id ? { ...item, reviewed: true } : item)),
      index,
      { intent },
    );
    if (nextIndex >= 0 && nextIndex !== index) setFocusId(rowsNow[nextIndex].id);
    else move(1);
  }

  function quantityDigit(digit) {
    const row = focused();
    if (!row) return;
    const buf = qtyBuffer;
    const fresh = buf.id !== row.id || Date.now() - buf.at > 1200;
    const typed = typeQuantity(fresh ? '' : buf.buffer, digit);
    qtyBuffer = { id: row.id, buffer: typed.buffer, at: Date.now() };
    if (typed.quantity) patchRows(targetIds(), { quantity: typed.quantity }, { label: `Qty ${typed.quantity}` });
  }

  function handleCommand(cmd) {
    const isClosed = closed();
    const row = focused();
    const current = draft();
    switch (cmd.command) {
      case 'cancel':
        if (confirmOpen()) setConfirmOpen(false);
        else if (replaceFor()) setReplaceFor('');
        else if (helpOpen()) setHelpOpen(false);
        else if (current) {
          setDraft(null);
          focusAddSearch();
        } else {
          setSelection(new Set());
          qtyBuffer = { id: '', buffer: '', at: 0 };
          if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
          queueEl?.focus();
        }
        return;
      case 'help':
        setHelpOpen((open) => !open);
        return;
      case 'move':
        if (current) return;
        move(cmd.delta);
        return;
      case 'nextAttention': {
        const i = nextAttentionIndex(list(), focusIndex(), { intent: submitIntent() });
        if (i >= 0) setFocusId(list()[i].id);
        return;
      }
      case 'set':
      case 'toggle':
      case 'cycleFinish':
        if (!isClosed) applyAttribute(cmd);
        return;
      case 'confirm':
        if (current) {
          commitDraft({ keep: false });
          return;
        }
        if (!isClosed) confirmFocused();
        return;
      case 'duplicate':
        if (current) {
          commitDraft({ keep: true });
          return;
        }
        if (!isClosed && row) duplicate(row);
        return;
      case 'remove':
        if (!isClosed && targetIds().length) removeRows(targetIds());
        return;
      case 'candidate': {
        if (isClosed || !row || current) return;
        const next = stepCandidate(row, cmd.delta);
        if (next) { markPick(row, next); patchRows([row.id], { cardId: next }, { label: 'Printing' }); }
        return;
      }
      case 'pickCandidate': {
        if (isClosed || !row || current) return;
        const cand = candidateList(row)[cmd.index];
        if (cand) { markPick(row, cand.cardId); patchRows([row.id], { cardId: cand.cardId }, { label: 'Printing' }); }
        return;
      }
      case 'qtyDigit':
        if (!isClosed && !current) quantityDigit(cmd.digit);
        return;
      case 'qtyStep':
        if (current) {
          const q = Math.max(1, Math.min(99, Number(current.quantity || 1) + cmd.delta));
          setDraft((prev) => (prev ? { ...prev, quantity: q } : null));
          return;
        }
        if (!isClosed && row) {
          const q = Math.max(1, Math.min(99, Number(row.quantity) + cmd.delta));
          patchRows(targetIds(), { quantity: q }, { label: `Qty ${q}` });
        }
        return;
      case 'qtyBackspace': {
        if (current) return;
        const buf = qtyBuffer;
        if (row && buf.id === row.id && buf.buffer.length > 1) {
          const next = buf.buffer.slice(0, -1);
          qtyBuffer = { ...buf, buffer: next, at: Date.now() };
          patchRows([row.id], { quantity: Number(next) });
        }
        return;
      }
      case 'replace':
        if (!isClosed && row && !current) setReplaceFor(row.id);
        return;
      case 'focusDefault':
        if (cmd.field === 'location') locationInput?.focus();
        else {
          // Alt Q opens the stack setup (cards per stack) behind the gear.
          stackButton?.focus();
          stackButton?.click();
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
        if (!isClosed && counts().ready) setConfirmOpen(true);
        return;
      default:
    }
  }

  onSettled(() => {
    function onKey(event) {
      // The confirm dialog's button has focus, so Enter there is a native click.
      const cmd = shortcutFor(event, {
        helpOpen: helpOpen(),
        modalOpen: confirmOpen() || Boolean(replaceFor()),
        draftActive: Boolean(draft()),
      });
      if (!cmd) return;
      event.preventDefault();
      handleCommand(cmd);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------------------------------------------------------------- prices + images

  watch(() => [list(), closed(), submitIntent(), priceRetry()], ([rowsNow, isClosed, intent]) => {
    if (isClosed || intent === 'collection') return undefined;
    const want = rowsNow
      .filter((row) => {
        if (!row.cardId || priceTouched.has(row.id)) return false;
        const signature = facetSignature(row);
        if (row.pricePkn == null) return !pricesAsked.has(`${row.id}:${signature}`);
        return row.priceSuggested === true && suggestedFor.get(row.id) !== signature;
      })
      .slice(0, 12);
    if (!want.length) return undefined;
    for (const row of want) {
      const signature = facetSignature(row);
      pricesAsked.add(`${row.id}:${signature}`);
      suggestedFor.set(row.id, signature);
    }
    let cancelled = false;
    (async () => {
      // Sold-comps slices once per printing (4 in flight, docs "once per printing").
      const queue = [...new Set(want.map((row) => String(row.cardId)))]
        .filter((id) => !slicesCache.has(id))
        .map((id) => () => {
          const pendingSlices = fetchCardSales(id, { slices: true })
            .then((data) => (Array.isArray(data?.slices) ? data.slices : []))
            .catch(() => []);
          slicesCache.set(id, pendingSlices);
          return pendingSlices;
        });
      while (queue.length) {
        await Promise.all(queue.splice(0, 4).map((run) => run()));
      }
      const cheapestIds = new Set();
      for (const row of want) {
        if (cancelled) return;
        const slices = await slicesCache.get(String(row.cardId));
        const pkn = suggestPriceFromSlices(slices, scanFacets(row));
        if (pkn > 0) {
          const patch = { pricePkn: Math.round(pkn), priceSuggested: true };
          lastSuggested.set(row.id, { signature: facetSignature(row), pkn: patch.pricePkn });
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
          lastSuggested.set(row.id, { signature: facetSignature(row), pkn: patch.pricePkn });
          if (row.pricePkn == null) patch.onlyIfEmptyPrice = true;
          patchRows([row.id], patch, { record: false });
        }
      }
    })().catch(() => {});
    return () => { cancelled = true; };
  });

  watch(() => [list(), images()], ([rowsNow, shots]) => {
    const wanted = rowsNow.filter((row) => row.hasImage && (row.recognitionState !== 'matched' || !row.cardId) && !shots[row.id]);
    if (!wanted.length) return undefined;
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
  });

  // ---------------------------------------------------------------- session actions

  async function regenerate() {
    try {
      const t = await token();
      const data = await scanApi.regenerate(t, session().id);
      setPairing(() => data.pairing);
    } catch (err) {
      if (err.code === 'session_expired') startSession(batch()?.id);
      else setError(err.message);
    }
  }

  async function sessionAction(action, extra) {
    try {
      if (action === 'disconnect') intentionalDisconnect = true;
      const id = session().id;
      const t = await token();
      const data = action === 'disconnect'
        ? await scanApi.disconnect(t, id)
        : action === 'pause'
          ? await scanApi.pause(t, id, extra)
          : await scanApi.end(t, id, extra);
      setSession(() => data.session);
      setPairing(() => data.pairing || null);
      if (action === 'disconnect') {
        setIdleDisconnectNote(false);
        wasPhoneConnected = false;
      }
      if (action === 'end') rememberActiveSession('');
    } catch (err) {
      setError(err.message);
    }
  }

  function togglePause() {
    const current = session();
    if (current && current.status === 'connected') sessionAction('pause', !current.paused);
  }

  async function submit(targets = pendingTargets) {
    const b = batch();
    if (submitting() || !b?.id) return;
    const intent = submitIntent();
    const nextTargets = intent === 'collection'
      ? { pokoin: true, cardtrader: false }
      : {
        pokoin: targets?.pokoin !== false,
        cardtrader: targets?.cardtrader === true,
      };
    pendingTargets = nextTargets;
    setSubmitting(true);
    setError('');
    try {
      const t = await token();
      const data = await scanApi.submit(t, b.id, submitKey, intent, nextTargets);
      setBatch((current) => ({ ...current, ...data.batch }));
      setConfirmOpen(false);
      setProblems({});
      if (data.cardtrader && data.cardtrader.ok === false) {
        setError(data.cardtrader.error || 'Listed on Pokoin; CardTrader push had errors.');
      }
      rememberActiveSession('');
      const snapshot = await scanApi.batch(t, b.id);
      dispatch({ type: 'items', items: snapshot.items });
      setSession(() => snapshot.session);
    } catch (err) {
      setConfirmOpen(false);
      if (err.code === 'not_ready') {
        setProblems(Object.fromEntries(err.problems.map((p) => [p.itemId, p.reason])));
        const rowsNow = list();
        const first = rowsNow.findIndex((row) => err.problems.some((p) => p.itemId === row.id));
        if (first >= 0) setFocusId(rowsNow[first].id);
      }
      setError(err.message || (intent === 'collection' ? 'Could not add to collection.' : 'Could not add to inventory.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function newBatch() {
    submitKey = newSubmitKey();
    pricesAsked = new Set();
    priceTouched = new Set();
    suggestedFor = new Map();
    lastSuggested = new Map();
    dispatch({ type: 'reset', items: [] });
    setBatch(null);
    await startSession();
  }

  // ---------------------------------------------------------------- render

  const waiting = () => session()?.status === 'waiting' && pairing();
  const expiresIn = () => {
    const pair = pairing();
    return pair ? Math.max(0, Math.round((Date.parse(pair.expiresAt) - (now() + serverOffset())) / 1000)) : 0;
  };
  const perfOn = () => typeof window !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1';
  const confirmCopy = () => {
    const rowsCount = counts().rows;
    if (submitIntent() === 'collection') return `${rowsCount} cards go into your collection.`;
    if (pendingTargets.cardtrader && pendingTargets.pokoin) return `${rowsCount} listings go live on Pokoin and CardTrader now.`;
    if (pendingTargets.cardtrader) return `${rowsCount} products go to CardTrader now.`;
    return `${rowsCount} listings go live on Pokoin now.`;
  };

  return (
    <div class="page desk scan-desk">
      <header class="scan-head">
        <div class="scan-head-title">
          <p class="page-kicker">Seller · Scan</p>
          <h1 class="page-title">Scan cards</h1>
        </div>
        <div class={`scan-status tone-${phaseInfo().tone}`} role="status" aria-live="polite">
          <span class="dot" aria-hidden="true" />
          <span>{session()?.paused ? 'Paused' : phaseInfo().text}</span>
          <Show when={streamStatus() === 'reconnecting'}><span class="scan-sub">· dashboard reconnecting</span></Show>
          <Show when={counts().cards}><span class="scan-sub">· {counts().cards} in queue</span></Show>
        </div>
        <div class="scan-head-actions">
          <Show when={session()?.status === 'connected'}>
            <button type="button" class="btn ghost" onClick={togglePause}>{session().paused ? 'Resume' : 'Pause'}</button>
            <button type="button" class="btn ghost" onClick={() => sessionAction('disconnect')}>Disconnect</button>
          </Show>
          <Show when={session() && session().status === 'ended' && !closed()}>
            <button type="button" class="btn" onClick={() => startSession(batch()?.id)}>Start new session</button>
          </Show>
          <button type="button" class="btn ghost icon-btn" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)">?</button>
          <a class="btn ghost" href="/mypokoin">MyPokoin</a>
        </div>
      </header>

      <Show when={error()}>
        <p class="scan-alert" role="alert">{error()} <button type="button" onClick={() => setError('')}>Dismiss</button></p>
      </Show>

      <Show
        when={waiting() && !closed()}
        fallback={(
          <Show when={!closed() && !session()}>
            <section class="scan-connect is-loading" aria-label="Connect your phone" aria-busy="true">
              <div class="scan-connect-main">
                <h2>Connect your phone</h2>
                <p class="scan-connect-step">Preparing pairing code…</p>
                <p class="scan-pin scan-pin-skeleton" aria-hidden="true">
                  <span /><span /><span /><span />
                </p>
              </div>
              <div class="scan-qr scan-qr-skeleton" aria-hidden="true" />
            </section>
          </Show>
        )}
      >
        <section class="scan-connect" aria-label="Connect your phone">
          <div class="scan-connect-main">
            <h2>{idleDisconnectNote() ? 'Reconnect phone' : 'Connect your phone'}</h2>
            <Show
              when={idleDisconnectNote()}
              fallback={<p class="scan-connect-step">Type the code on <strong>scan.pokoin.com/connect</strong>, or scan the QR code</p>}
            >
              <p class="scan-connect-step">Phone disconnected after 10 minutes without a scan. Pair again to continue this batch.</p>
            </Show>
            <p class="scan-pin" aria-label={`Pairing code ${pairing().pin.split('').join(' ')}`}>
              <For each={pairing().pin.split('')}>{(digit) => <span>{digit}</span>}</For>
            </p>
            <p class="scan-connect-meta">
              {expiresIn() > 0 ? `Code expires in ${Math.floor(expiresIn() / 60)}:${String(expiresIn() % 60).padStart(2, '0')}` : 'Code expired'}
              {' · '}
              <button type="button" class="linkish" onClick={regenerate}>New code</button>
            </p>
          </div>
          <QrBlock secret={pairing().qrSecret} pin={pairing().pin} />
        </section>
      </Show>

      <Show
        when={closed()}
        fallback={(
          <>
            <section class="scan-intent" aria-label="What do you want to do?">
              <p class="scan-intent-label">What do you want to do?</p>
              <div class="scan-intent-seg" role="group">
                <button
                  type="button"
                  class={submitIntent() === 'list' ? 'on' : ''}
                  aria-pressed={String(submitIntent() === 'list')}
                  data-testid="scan-intent-list"
                  onClick={() => setSubmitIntent('list')}
                >
                  List for sale
                </button>
                <button
                  type="button"
                  class={submitIntent() === 'collection' ? 'on' : ''}
                  aria-pressed={String(submitIntent() === 'collection')}
                  data-testid="scan-intent-collection"
                  onClick={() => setSubmitIntent('collection')}
                >
                  Add to collection
                </button>
              </div>
            </section>
            <DefaultsBar
              defaults={defaults()}
              boxes={recentBoxNames()}
              stackFull={stackFull()}
              onChange={setDefaults}
              positionForStack={positionForStack}
              locationRef={(el) => { locationInput = el; }}
              stackButtonRef={(el) => { stackButton = el; }}
            />
          </>
        )}
      >
        <section class="scan-done">
          <h2>
            {batch().status === 'submitted'
              ? (batch().submitResult?.intent === 'collection'
                ? `Added ${batch().submitResult?.cards ?? counts().cards} cards to your collection`
                : `Added ${batch().submitResult?.cards ?? counts().cards} cards to Inventory`)
              : 'Batch discarded'}
          </h2>
          <p>
            {batch().submitResult?.intent === 'collection'
              ? `${batch().submitResult?.ownership ?? 0} collection records saved. None listed for sale.`
              : `${batch().submitResult?.listings ?? 0} listings are live (also added to your collection).`}
          </p>
          <div class="scan-done-actions">
            <a class="btn ghost" href={marketUrl('/mypokoin/collection')}>View collection</a>
            <Show when={batch().submitResult?.intent !== 'collection'}>
              <a class="btn ghost" href="/mypokoin">Open MyPokoin</a>
            </Show>
            <button type="button" class="btn" onClick={newBatch}>Scan another batch</button>
          </div>
        </section>
      </Show>

      <Show when={!closed()}>
        <ManualAddBar
          draft={draft()}
          qtyRef={(el) => { draftQtyInput = el; }}
          qtyInput={() => draftQtyInput}
          searchRef={(el) => { addSearchInput = el; }}
          onPickCard={startDraft}
          onDraftChange={(next) => setDraft(() => next)}
          onCreate={() => commitDraft({ keep: false })}
          onCreateCopy={() => commitDraft({ keep: true })}
          onCancelDraft={() => {
            setDraft(null);
            focusAddSearch();
          }}
        />
      </Show>

      <div class="scan-toolbar">
        <span class="scan-counts">
          <strong>{counts().cards}</strong> cards · {counts().rows} rows
          {counts().merged ? ` · ${counts().merged} repeat${counts().merged === 1 ? '' : 's'} merged` : ''}
          <Show when={counts().needsReview}>
            <button type="button" class="chip warn" onClick={() => handleCommand({ command: 'nextAttention' })}>{counts().needsReview} to check</button>
          </Show>
          <Show when={counts().noPrinting}><span class="chip bad">{counts().noPrinting} unidentified</span></Show>
          <Show when={counts().noPrice && submitIntent() === 'list'}><span class="chip warn">{counts().noPrice} need a price</span></Show>
        </span>
        <Show when={!closed()}>
          <Show
            when={submitIntent() === 'list'}
            fallback={(
              <button
                type="button"
                class="btn scan-submit"
                disabled={!counts().ready || submitting()}
                onClick={() => setConfirmOpen(true)}
                title="⌘Enter"
              >
                {submitting() ? 'Adding…' : submitLabel(counts(), { intent: submitIntent() })}
              </button>
            )}
          >
            <InventoryTargets
              mode="add"
              counts={counts()}
              intent={submitIntent()}
              disabled={!counts().ready}
              busy={submitting()}
              busyLabel="Adding…"
              onSubmit={(targets) => {
                pendingTargets = targets;
                setConfirmOpen(true);
              }}
            />
          </Show>
        </Show>
      </div>

      <div
        class={['scan-queue', { 'intent-collection': submitIntent() === 'collection' }]}
        role="grid"
        aria-label="Scan queue"
        tabindex={0}
        ref={(el) => { queueEl = el; }}
      >
        <div class="scan-row scan-row-head" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader" class="c-card-head">Card</span>
          <span role="columnheader">Lang</span>
          <span role="columnheader">Cond</span>
          <span role="columnheader">Finish</span>
          <span role="columnheader">Flags</span>
          <span role="columnheader">Location</span>
          <span role="columnheader">Qty</span>
          <Show when={submitIntent() === 'list'}>
            <span role="columnheader">Price{priceCurrency() !== 'PKN' ? ` · ${priceCurrency()}` : ''}</span>
          </Show>
          <span role="columnheader">State</span>
          <span role="columnheader" class="c-remove" aria-label="Remove" />
        </div>
        <Show when={list().length === 0}>
          <p class="scan-empty">
            {session()?.status === 'connected'
              ? 'Scan a card with your phone, or search above to add one.'
              : 'Search above to add a card, or connect your phone to scan.'}
          </p>
        </Show>
        <For each={list()} keyed={(row) => row.id}>
          {(row, index) => (
            <QueueRow
              row={row()}
              index={index()}
              focused={row().id === focusId()}
              selected={selection().has(row().id)}
              problem={problems()[row().id] || rowProblem(row(), { intent: submitIntent() })}
              image={images()[row().id]}
              closed={closed()}
              hidePrice={submitIntent() === 'collection'}
              priceCurrency={priceCurrency()}
              slot={slots().get(row().id)}
              replacing={replaceFor() === row().id}
              preferredLanguage={defaults().language}
              onPriceFocus={(rowId) => priceTouched.add(rowId)}
              onPriceEmptied={restoreDefaultPrice}
              onFocus={(event) => {
                const rowsNow = list();
                const at = index();
                const anchor = focusId();
                if (event.shiftKey && anchor) {
                  const a = rowsNow.findIndex((r) => r.id === anchor);
                  const [from, to] = a < at ? [a, at] : [at, a];
                  setSelection(new Set(rowsNow.slice(from, to + 1).map((r) => r.id)));
                } else {
                  setSelection(new Set());
                  setFocusId(row().id);
                }
                followTail = at === rowsNow.length - 1;
              }}
              onPatch={(changes) => patchRows([row().id], changes)}
              onPick={(cardId) => { markPick(row(), cardId); patchRows([row().id], { cardId }, { label: 'Printing' }); }}
              onRemove={() => removeRows([row().id])}
              onReplaceDone={() => {
                setReplaceFor('');
                queueEl?.focus();
              }}
            />
          )}
        </For>
      </div>

      <div class="scan-toasts" aria-live="polite">
        <For each={toasts()}>
          {(toast) => (
            <div class="scan-toast">
              <span>{toast.text}</span>
              <Show
                when={toast.itemId}
                fallback={(
                  <Show when={toast.run}>
                    <button type="button" onClick={toast.run}>{toast.action}</button>
                  </Show>
                )}
              >
                <button type="button" onClick={() => runApi((t) => scanApi.unmerge(t, toast.itemId, batch()?.id))}>Undo</button>
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show when={confirmOpen()}>
        <div class="scan-modal" role="dialog" aria-modal="true" aria-label="Add to inventory">
          <div class="scan-modal-box">
            <h2>{submitLabel(counts(), { intent: submitIntent(), targets: pendingTargets })}?</h2>
            <p>{confirmCopy()}</p>
            <div class="scan-modal-actions">
              <button type="button" class="btn ghost" onClick={() => setConfirmOpen(false)}>Cancel (Esc)</button>
              <AutoFocusButton class="btn" onClick={() => submit(pendingTargets)} disabled={submitting()}>
                {submitting() ? 'Adding…' : 'Add (Enter)'}
              </AutoFocusButton>
            </div>
          </div>
        </div>
      </Show>

      <Show when={helpOpen()}><HelpOverlay onClose={() => setHelpOpen(false)} /></Show>

      <Show when={perfOn()}><PerfPanel now={now()} /></Show>
    </div>
  );
}

/** /inventory/scan and /dashboard/scan (market/src/pages/ScanDesk.jsx). */
export default function ScanDesk() {
  const location = useLocation();
  usePageTitle('Scan · Pokoin');
  return (
    <RequireSignIn to={`/auth?from=${encodeURIComponent(location.pathname || '/inventory/scan')}`}>
      <ScanDeskDesk />
    </RequireSignIn>
  );
}
