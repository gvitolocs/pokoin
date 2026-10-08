'use strict';

/**
 * GET /api/news-stats?days=30 — admin-only Pokoin News reading stats for
 * pokoin.com/news/dashboard, aggregated from `news_events` (POST /api/news-event).
 *
 *   ctr            list clicks / list impressions
 *   views/readers  distinct page loads / distinct daily visitor hashes
 *   depth          share of views that scrolled past 25/50/75/100%
 *   medianSeconds  active seconds on the article before the tab hid (per view, max)
 *
 * Admin = the same users/{uid} profile signal the SPA uses (auth.jsx).
 */

const path = require('path');

const DEFAULT_DAYS = 30;
const MAX_ARTICLES = 300;
const WINDOW = `created_at >= now() - make_interval(days => $1::int)`;

function requireHelper(name) {
  try {
    return require(path.join(__dirname, '..', 'server', name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

const SQL = {
  articles: `
    select article_id, max(article_path) as article_path,
           count(*) filter (where event_type = 'impression') as impressions,
           count(*) filter (where event_type = 'click') as clicks,
           count(distinct pv) filter (where event_type = 'view') as views,
           count(distinct (visitor, created_at::date)) filter (where event_type = 'view') as readers
    from public.news_events
    where ${WINDOW}
    group by article_id`,
  depth: `
    select article_id,
           count(*) filter (where d >= 25) as d25,
           count(*) filter (where d >= 50) as d50,
           count(*) filter (where d >= 75) as d75,
           count(*) filter (where d >= 100) as d100
    from (
      select article_id, pv, max(depth) as d
      from public.news_events
      where ${WINDOW} and event_type in ('read', 'leave') and depth is not null
      group by article_id, pv
    ) per_view
    group by article_id`,
  time: `
    select article_id,
           percentile_cont(0.5) within group (order by s) as median_seconds,
           percentile_cont(0.75) within group (order by s) as p75_seconds,
           count(*) filter (where s < 10) as quick_exits,
           count(*) as timed
    from (
      select article_id, pv, max(seconds) as s
      from public.news_events
      where ${WINDOW} and event_type = 'leave'
      group by article_id, pv
    ) per_view
    group by article_id`,
  daily: `
    select to_char(created_at::date, 'YYYY-MM-DD') as day,
           count(distinct pv) filter (where event_type = 'view') as views,
           count(*) filter (where event_type = 'click') as clicks,
           count(*) filter (where event_type = 'impression') as impressions
    from public.news_events
    where ${WINDOW}
    group by created_at::date
    order by created_at::date`,
  positions: `
    select position,
           count(*) filter (where event_type = 'impression') as impressions,
           count(*) filter (where event_type = 'click') as clicks
    from public.news_events
    where ${WINDOW} and event_type in ('impression', 'click') and position is not null
    group by position
    order by position
    limit 50`,
  overall: `
    select percentile_cont(0.5) within group (order by s) as median_seconds
    from (
      select max(seconds) as s
      from public.news_events
      where ${WINDOW} and event_type = 'leave'
      group by article_id, pv
    ) per_view`,
};

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function share(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 10000) / 10000 : null;
}

function cleanDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_DAYS;
}

/** Same admin signal the SPA derives from the users/{uid} profile (auth.jsx). */
async function callerIsAdmin(firestore, decoded) {
  if (decoded?.admin === true) return true;
  const uid = String(decoded?.uid || '').trim();
  if (!uid) return false;
  try {
    const doc = await firestore.collection('users').doc(uid).get();
    const profile = doc.data() || {};
    if (profile.admin === true || profile.isAdmin === true) return true;
    if (String(profile.role || '').trim().toLowerCase() === 'admin') return true;
    const roles = Array.isArray(profile.roles)
      ? profile.roles
      : typeof profile.roles === 'string'
        ? profile.roles.split(',')
        : [];
    return roles.map((role) => String(role || '').trim().toLowerCase()).includes('admin');
  } catch (error) {
    console.warn('news-stats admin lookup failed', error.message);
    return false;
  }
}

function buildStats({ days, now, articles, depth, time, daily, positions, overall }) {
  const depthBy = new Map(depth.map((row) => [row.article_id, row]));
  const timeBy = new Map(time.map((row) => [row.article_id, row]));
  const rows = articles.map((row) => {
    const views = num(row.views);
    const impressions = num(row.impressions);
    const clicks = num(row.clicks);
    const d = depthBy.get(row.article_id) || {};
    const t = timeBy.get(row.article_id) || {};
    const timed = num(t.timed);
    return {
      articleId: row.article_id,
      articlePath: row.article_path,
      impressions,
      clicks,
      ctr: share(clicks, impressions),
      views,
      readers: num(row.readers),
      depth: {
        25: share(num(d.d25), views),
        50: share(num(d.d50), views),
        75: share(num(d.d75), views),
        100: share(num(d.d100), views),
      },
      medianSeconds: numOrNull(t.median_seconds),
      p75Seconds: numOrNull(t.p75_seconds),
      quickExitShare: share(num(t.quick_exits), timed),
      timed,
    };
  });
  rows.sort((a, b) => b.views - a.views || b.impressions - a.impressions);
  const totals = rows.reduce(
    (sum, row) => ({
      impressions: sum.impressions + row.impressions,
      clicks: sum.clicks + row.clicks,
      views: sum.views + row.views,
      readers: sum.readers + row.readers,
    }),
    { impressions: 0, clicks: 0, views: 0, readers: 0 },
  );
  return {
    days,
    generatedAt: now.toISOString(),
    totals: {
      ...totals,
      ctr: share(totals.clicks, totals.impressions),
      medianSeconds: numOrNull(overall[0]?.median_seconds),
    },
    articles: rows.slice(0, MAX_ARTICLES),
    daily: daily.map((row) => ({ day: String(row.day), views: num(row.views), clicks: num(row.clicks), impressions: num(row.impressions) })),
    positions: positions.map((row) => {
      const impressions = num(row.impressions);
      const clicks = num(row.clicks);
      return { position: num(row.position), impressions, clicks, ctr: share(clicks, impressions) };
    }),
  };
}

/** Handler factory; tests inject firestore, verify, query and now. */
function createHandler({
  firestore = () => requireHelper('_firebase').getFirebaseAdmin().firestore(),
  verify = (req) => requireHelper('_firebase').verifyBearerToken(req),
  query = (...args) => requireHelper('_marketplace_db').marketplaceQuery(...args),
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    let decoded;
    try {
      decoded = await verify(req);
    } catch {
      return res.status(401).json({ error: 'Sign in as an admin.' });
    }
    if (!(await callerIsAdmin(firestore(), decoded))) return res.status(403).json({ error: 'Admins only.' });

    const days = cleanDays(req.query?.days);
    try {
      const run = (sql) => query(sql, [days]).then((result) => result?.rows || []);
      const [articles, depth, time, daily, positions, overall] = await Promise.all([
        run(SQL.articles),
        run(SQL.depth),
        run(SQL.time),
        run(SQL.daily),
        run(SQL.positions),
        run(SQL.overall),
      ]);
      return res.status(200).json(buildStats({ days, now: now(), articles, depth, time, daily, positions, overall }));
    } catch (error) {
      console.error('news-stats failed', error?.message || error);
      return res.status(500).json({ error: 'News stats are unavailable right now.' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports._test = { SQL, buildStats, callerIsAdmin, cleanDays };
