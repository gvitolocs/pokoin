/**
 * Pricing strategies and groups shared by the MyPokoin and Scan desk layout
 * previews (?mypokoinPreview / ?scanPreview). This module is deliberately tiny
 * and free of the row fixtures: the Scan desk reads it statically, and pulling
 * the whole preview book into that chunk would ship fixture data to production.
 */

/** Named strategies as the server stores them (no scope: groups pick one by name). */
export function previewStrategies() {
  const rule = {
    source: 'cardtrader', basis: 'offers', match: { condition: true, language: true, finish: true, firstEdition: true },
    feeExclusive: true, amountPkn: 0, rounding: 'integer', minPkn: 1,
  };
  return [
    { ...rule, id: 'preview-strategy-1', name: 'Undercut 5% · CardTrader net', action: 'undercut', amountPct: 5, activatePaused: true },
    {
      ...rule,
      id: 'preview-strategy-2',
      name: 'Match CardTrader · same language',
      match: { condition: false, language: true, finish: false, firstEdition: false },
      feeExclusive: false,
      action: 'match',
      amountPct: 0,
      activatePaused: false,
    },
    { ...rule, id: 'preview-strategy-3', name: 'Sold median +10%', basis: 'sold', action: 'premium', amountPct: 10, activatePaused: false },
    {
      id: 'preview-strategy-4',
      name: 'Cardmarket trend −3%',
      source: 'cardmarket',
      basis: 'trend',
      match: { condition: true, language: true, finish: true, firstEdition: true },
      feeExclusive: false,
      action: 'undercut',
      amountPct: 3,
      amountPkn: 0,
      rounding: 'integer',
      minPkn: 1,
      activatePaused: false,
    },
    {
      id: 'preview-strategy-5',
      name: 'TCGplayer market',
      source: 'tcgplayer',
      basis: 'market',
      match: { condition: true, language: true, finish: true, firstEdition: true },
      feeExclusive: false,
      action: 'match',
      amountPct: 0,
      amountPkn: 0,
      rounding: 'up',
      minPkn: 1,
      activatePaused: false,
    },
    {
      id: 'preview-strategy-6',
      name: 'Undercut Cardmarket pro sellers 2%',
      source: 'cardmarketoffers',
      basis: 'pro',
      match: { condition: true, language: true, finish: true, firstEdition: true },
      feeExclusive: false,
      action: 'undercut',
      amountPct: 2,
      amountPkn: 0,
      rounding: 'integer',
      minPkn: 1,
      activatePaused: false,
    },
  ];
}

/**
 * Pricing groups over the preview listings: one repriced daily, one applied
 * by hand, one never applied. preview-list-8 is in no group.
 */
export function previewGroups() {
  return {
    groups: [
      {
        id: 'preview-group-1',
        name: 'Base Set holos',
        strategyId: 'preview-strategy-1',
        autoDaily: true,
        lastAppliedAt: '2026-11-03T05:00:00.000Z',
        lastApplied: { changed: 2, activated: 1, noComp: 0, unchanged: 0, failed: 0, trigger: 'daily' },
      },
      {
        id: 'preview-group-2',
        name: 'Modern singles',
        strategyId: 'preview-strategy-2',
        autoDaily: false,
        lastAppliedAt: '2026-10-28T17:20:00.000Z',
        lastApplied: { changed: 3, activated: 0, noComp: 1, unchanged: 0, failed: 0, trigger: 'manual' },
      },
      {
        id: 'preview-group-3',
        name: 'Slow movers',
        strategyId: 'preview-strategy-3',
        autoDaily: false,
        lastAppliedAt: null,
        lastApplied: null,
      },
    ],
    memberships: [
      ['preview-list-1', 'preview-group-1'],
      ['preview-list-2', 'preview-group-1'],
      ['preview-list-3', 'preview-group-1'],
      ['preview-list-4', 'preview-group-2'],
      ['preview-list-5', 'preview-group-2'],
      ['preview-list-6', 'preview-group-2'],
      ['preview-list-9', 'preview-group-2'],
      ['preview-list-7', 'preview-group-3'],
    ],
  };
}
