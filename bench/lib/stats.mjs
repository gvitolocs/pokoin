// Distribution summaries for benchmark samples.

/** Rounds to 3 decimals so JSON stays readable. */
export function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

/** Linear-interpolated percentile of an ascending array (numpy "linear"). */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Summary of numeric samples; null/undefined/NaN are counted as `nulls`. */
export function summarize(values) {
  const nums = [];
  let nulls = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) nums.push(value);
    else nulls += 1;
  }
  nums.sort((a, b) => a - b);
  if (!nums.length) {
    return { n: 0, nulls, min: null, p50: null, p75: null, p95: null, p99: null, max: null, mean: null };
  }
  const sum = nums.reduce((acc, value) => acc + value, 0);
  return {
    n: nums.length,
    nulls,
    min: round(nums[0]),
    p50: round(percentile(nums, 50)),
    p75: round(percentile(nums, 75)),
    p95: round(percentile(nums, 95)),
    p99: round(percentile(nums, 99)),
    max: round(nums[nums.length - 1]),
    mean: round(sum / nums.length),
  };
}

/**
 * Summarises every metric key over the ok runs of one journey. Scalar metrics give
 * one sample per run; array metrics are pooled across runs (`pooled: true`).
 */
export function summarizeJourney(runs) {
  const samples = new Map();
  const pooled = new Set();
  for (const run of runs) {
    if (!run?.ok || !run.metrics) continue;
    for (const [key, value] of Object.entries(run.metrics)) {
      if (!samples.has(key)) samples.set(key, []);
      if (Array.isArray(value)) {
        pooled.add(key);
        samples.get(key).push(...value);
      } else {
        samples.get(key).push(value);
      }
    }
  }
  const out = {};
  for (const key of [...samples.keys()].sort()) {
    out[key] = summarize(samples.get(key));
    if (pooled.has(key)) out[key].pooled = true;
  }
  return out;
}
