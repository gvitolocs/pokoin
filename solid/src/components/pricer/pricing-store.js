import { createMemo, createSignal, untrack } from 'solid-js';
import {
  applyPricing,
  deletePricingGroup,
  deletePricingStrategy,
  fetchPricingGroups,
  fetchPricingStrategies,
  savePricingGroup,
  savePricingStrategies,
} from '@market/api.js';
import { membershipMap, normalizeStrategy } from '@market/pricer.js';
import { game } from '@market/game.js';
import { getBearer } from '../../stores/auth.js';
import { rememberedComp } from '../inventory/price-memo.js';
import * as local from './pricer-local.js';

/**
 * The seller's strategies, pricing groups and memberships: one source for
 * the listings board and the Pricer tab (MyPokoin desk). Every change
 * refreshes it. In the layout preview (`preview`), every save, move and
 * apply runs on fixture state (`pricer-local.js`) and never calls the API.
 *
 * options: { preview, previewState: { strategies, groups, pairs },
 *            previewComps, rows: () => rows, setRows(rows) }
 */
export function createPricing(options = {}) {
  const preview = Boolean(options.preview);
  // The preview's source of truth is a plain object, so a change reads its
  // own result at once (signal writes apply on the next flush).
  let previewState = preview
    ? { strategies: [], groups: [], pairs: [], ...(options.previewState || {}) }
    : null;
  const first = preview ? local.snapshot(previewState) : { strategies: [], groups: [], memberships: [] };
  const [strategies, setStrategies] = createSignal(first.strategies);
  const [groups, setGroups] = createSignal(first.groups);
  const [pairs, setPairs] = createSignal(first.memberships);
  const [loaded, setLoaded] = createSignal(preview);
  const [error, setError] = createSignal('');
  // Bumped on every change: dry runs re-plan on it.
  const [version, setVersion] = createSignal(0);
  let versionValue = 0;
  const memberships = createMemo(() => membershipMap(pairs()));

  function bump() {
    versionValue += 1;
    setVersion(versionValue);
  }

  function publish(data) {
    if (data.strategies) setStrategies(() => data.strategies);
    if (data.groups) setGroups(() => data.groups);
    if (data.memberships) setPairs(() => data.memberships);
    bump();
  }

  function commitPreview(state) {
    previewState = state;
    publish(local.snapshot(state));
  }

  /** Reload everything; answers the strategies response (it carries pricerSettings). */
  async function refresh() {
    if (preview) {
      publish(local.snapshot(previewState));
      return null;
    }
    let strategyData;
    let groupData;
    try {
      const token = await getBearer();
      [strategyData, groupData] = await Promise.all([fetchPricingStrategies(token), fetchPricingGroups(token)]);
    } catch (err) {
      setError(err.message || 'Could not load your pricing groups.');
      throw err;
    }
    publish({
      strategies: strategyData.strategies || [],
      groups: groupData.groups || strategyData.groups || [],
      memberships: groupData.memberships || [],
    });
    setError('');
    setLoaded(true);
    return strategyData;
  }

  async function settle(data) {
    publish(data);
    // Strategy "Used by" names and group counts follow the change.
    await refresh().catch((err) => setError(err.message || 'Could not reload your pricing groups.'));
    return data;
  }

  /** savePricingGroup: answers `{ groupId, added, removed, groups, memberships }`. */
  async function saveGroup(body) {
    if (preview) {
      const answer = local.saveGroup(previewState, body);
      commitPreview(answer.state);
      return { groupId: answer.groupId, added: answer.added, removed: answer.removed };
    }
    const token = await getBearer();
    return settle(await savePricingGroup(body, token));
  }

  async function deleteGroup(id) {
    if (preview) {
      commitPreview(local.deleteGroup(previewState, id));
      return {};
    }
    const token = await getBearer();
    return settle(await deletePricingGroup(id, token));
  }

  /** savePricingStrategies({ strategy }): answers the saved id. */
  async function saveStrategy(input) {
    const strategy = normalizeStrategy(input);
    if (preview) {
      const answer = local.saveStrategy(previewState, strategy);
      commitPreview(answer.state);
      return answer.savedId;
    }
    const token = await getBearer();
    const data = await settle(await savePricingStrategies({ strategy }, token));
    return data.savedId || strategy.id;
  }

  async function deleteStrategy(id) {
    if (preview) {
      commitPreview(local.deleteStrategy(previewState, id));
      return;
    }
    const token = await getBearer();
    await settle(await deletePricingStrategy(id, token));
  }

  /** applyPricing({ groupId, dryRun }). A real apply refreshes groups and the board. */
  async function apply(body) {
    if (preview) {
      const answer = local.applyGroup(previewState, untrack(() => options.rows?.() || []), options.previewComps || {}, body);
      if (!body.dryRun) {
        options.setRows?.(answer.rows);
        commitPreview(answer.state);
      }
      const { state: _state, rows: _rows, ...result } = answer;
      return result;
    }
    const token = await getBearer();
    const result = await applyPricing(body, token);
    if (!body.dryRun) await refresh().catch((err) => setError(err.message || 'Could not reload your pricing groups.'));
    return result;
  }

  /**
   * A row's price-check entry without a request: the fixture's in preview,
   * else whatever the board already loaded for its market column (or null).
   */
  const compFor = preview ? local.compLookup(options.previewComps || {}) : (row) => rememberedComp(row, untrack(() => game().id));

  return {
    preview,
    compFor,
    strategies,
    groups,
    pairs,
    memberships,
    loaded,
    error,
    version,
    refresh,
    saveGroup,
    deleteGroup,
    saveStrategy,
    deleteStrategy,
    apply,
  };
}
