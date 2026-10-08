// Pokoin News admin dashboard (/news/dashboard): reading stats from
// GET https://api.pokoin.com/api/news-stats, which answers only to admin
// accounts (401 signed out, 403 not admin). The sign-in token is the
// `pokoin.auth.token` cookie the marketplace writes on pokoin.com. Without an
// admin answer the page shows nothing but an "Admins only" note.
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // { token, uid } from the marketplace sign-in cookie, or null when signed out/expired.
  function session() {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i += 1) {
      var at = parts[i].indexOf('=');
      if (at < 0 || parts[i].slice(0, at).trim() !== 'pokoin.auth.token') continue;
      try {
        var value = JSON.parse(decodeURIComponent(parts[i].slice(at + 1).trim()));
        if (value && value.token && Number(value.expiresAt) > Date.now() + 30000) return value;
      } catch (error) { return null; }
    }
    return null;
  }

  function pct(value) {
    return value == null ? '—' : (value * 100).toFixed(1) + '%';
  }

  function duration(seconds) {
    if (seconds == null) return '—';
    var s = Math.round(seconds);
    var rest = s % 60;
    return Math.floor(s / 60) + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function count(value) {
    return String(Number(value) || 0);
  }

  function dashboard() {
    var root = document.querySelector('.nx-dash');
    if (!root || !window.fetch) return;
    var api = root.getAttribute('data-stats-api');
    var status = root.querySelector('.nx-dash__status');
    var body = root.querySelector('.nx-dash__body');
    var range = root.querySelector('.nx-dash__range');
    var select = root.querySelector('#nx-dash-days');
    var articles = {};
    try {
      var index = JSON.parse(document.getElementById('nx-dash-articles').textContent || '[]');
      for (var i = 0; i < index.length; i += 1) articles[index[i].id] = index[i];
    } catch (error) { articles = {}; }

    function block(message, linkText) {
      body.hidden = true;
      body.textContent = '';
      range.hidden = true;
      status.hidden = false;
      status.textContent = message;
      if (linkText) {
        var link = el('a', '', linkText);
        link.href = '/auth?from=%2Fnews%2Fdashboard';
        link.rel = 'nofollow';
        status.appendChild(link);
      }
    }

    var auth = session();
    if (!auth) {
      block('Admins only. ', 'Sign in with an admin account');
      return;
    }

    var sortKey = 'views';
    var sortDir = -1;
    var data = null;

    function load(days) {
      status.hidden = false;
      status.textContent = 'Loading…';
      fetch(api + '?days=' + encodeURIComponent(days), {
        headers: { Authorization: 'Bearer ' + auth.token },
        credentials: 'omit',
      })
        .then(function (response) {
          if (response.status === 401) throw new Error('signin');
          if (response.status === 403) throw new Error('forbidden');
          if (!response.ok) throw new Error('unavailable');
          return response.json();
        })
        .then(function (json) {
          data = json;
          status.hidden = true;
          range.hidden = false;
          body.hidden = false;
          render();
        })
        .catch(function (error) {
          if (error.message === 'signin') block('Admins only. ', 'Sign in with an admin account');
          else if (error.message === 'forbidden') block('Admins only — this account is not an admin.');
          else block('Stats are unavailable right now.');
        });
    }

    function kpis() {
      var t = data.totals || {};
      var grid = el('div', 'nx-dash__kpis');
      var tiles = [
        ['Views', count(t.views)],
        ['Readers', count(t.readers)],
        ['Impressions', count(t.impressions)],
        ['Clicks', count(t.clicks)],
        ['CTR', pct(t.ctr)],
        ['Median time on page', duration(t.medianSeconds)],
      ];
      for (var i = 0; i < tiles.length; i += 1) {
        var tile = el('div', 'nx-dash__kpi');
        tile.appendChild(el('span', '', tiles[i][0]));
        tile.appendChild(el('strong', '', tiles[i][1]));
        grid.appendChild(tile);
      }
      return grid;
    }

    function chart() {
      var daily = data.daily || [];
      var figure = el('figure', 'nx-dash__chart');
      if (!daily.length) {
        figure.appendChild(el('figcaption', '', 'No data yet for this period.'));
        return figure;
      }
      var width = Math.max(320, daily.length * 12);
      var height = 160;
      var max = 1;
      for (var i = 0; i < daily.length; i += 1) max = Math.max(max, Number(daily[i].views) || 0);
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Views per day');
      var slot = width / daily.length;
      for (var d = 0; d < daily.length; d += 1) {
        var day = daily[d];
        var h = Math.max(1, ((Number(day.views) || 0) / max) * (height - 8));
        var rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(d * slot + slot * 0.15));
        rect.setAttribute('y', String(height - h));
        rect.setAttribute('width', String(Math.max(1, slot * 0.7)));
        rect.setAttribute('height', String(h));
        var title = document.createElementNS(SVG_NS, 'title');
        title.textContent = day.day + ': ' + count(day.views) + ' views, ' + count(day.clicks) + ' clicks';
        rect.appendChild(title);
        svg.appendChild(rect);
      }
      figure.appendChild(svg);
      figure.appendChild(el('figcaption', '', 'Views per day · ' + daily[0].day + ' → ' + daily[daily.length - 1].day));
      return figure;
    }

    var COLUMNS = [
      { key: 'title', label: 'Article', text: true },
      { key: 'published', label: 'Published', text: true },
      { key: 'views', label: 'Views' },
      { key: 'readers', label: 'Readers' },
      { key: 'impressions', label: 'Impr.' },
      { key: 'clicks', label: 'Clicks' },
      { key: 'ctr', label: 'CTR', format: pct },
      { key: 'd25', label: 'Read 25%', format: pct },
      { key: 'd50', label: 'Read 50%', format: pct },
      { key: 'd75', label: 'Read 75%', format: pct },
      { key: 'd100', label: 'Read 100%', format: pct },
      { key: 'medianSeconds', label: 'Median time', format: duration },
      { key: 'p75Seconds', label: 'P75 time', format: duration },
      { key: 'quickExitShare', label: 'Quick exits (<10s)', format: pct },
    ];

    function rowsFor() {
      return (data.articles || []).map(function (row) {
        var meta = articles[row.articleId] || {};
        var depth = row.depth || {};
        return {
          title: meta.headline || row.articlePath,
          path: meta.path || row.articlePath,
          published: meta.datePublished ? String(meta.datePublished).slice(0, 10) : '',
          views: row.views,
          readers: row.readers,
          impressions: row.impressions,
          clicks: row.clicks,
          ctr: row.ctr,
          d25: depth['25'],
          d50: depth['50'],
          d75: depth['75'],
          d100: depth['100'],
          medianSeconds: row.medianSeconds,
          p75Seconds: row.p75Seconds,
          quickExitShare: row.quickExitShare,
        };
      });
    }

    function compare(a, b) {
      var x = a[sortKey];
      var y = b[sortKey];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return x.localeCompare(y) * sortDir;
      return (x - y) * sortDir;
    }

    function articleTable() {
      var table = el('table', 'nx-table nx-dash__table');
      table.appendChild(el('caption', '', 'Articles — click a column to sort'));
      var head = el('thead');
      var headRow = el('tr');
      COLUMNS.forEach(function (column) {
        var th = el('th');
        th.scope = 'col';
        if (column.key === sortKey) th.setAttribute('aria-sort', sortDir < 0 ? 'descending' : 'ascending');
        var button = el('button', '', column.label + (column.key === sortKey ? (sortDir < 0 ? ' ↓' : ' ↑') : ''));
        button.type = 'button';
        button.addEventListener('click', function () {
          if (sortKey === column.key) sortDir = -sortDir;
          else {
            sortKey = column.key;
            sortDir = column.text ? 1 : -1;
          }
          render();
        });
        th.appendChild(button);
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      table.appendChild(head);
      var tbody = el('tbody');
      var rows = rowsFor().sort(compare);
      if (!rows.length) {
        var empty = el('tr');
        var cell = el('td', '', 'No reads recorded yet.');
        cell.colSpan = COLUMNS.length;
        empty.appendChild(cell);
        tbody.appendChild(empty);
      }
      rows.forEach(function (row) {
        var tr = el('tr');
        COLUMNS.forEach(function (column) {
          var td = el(column.key === 'title' ? 'th' : 'td');
          if (column.key === 'title') {
            td.scope = 'row';
            var link = el('a', '', row.title);
            link.href = row.path;
            td.appendChild(link);
          } else {
            td.textContent = column.format ? column.format(row[column.key]) : column.text ? row[column.key] : count(row[column.key]);
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      return table;
    }

    function positionTable() {
      var table = el('table', 'nx-table');
      table.appendChild(el('caption', '', 'Click-through by card position'));
      var head = el('thead');
      var headRow = el('tr');
      ['Position', 'Impressions', 'Clicks', 'CTR'].forEach(function (label) {
        var th = el('th', '', label);
        th.scope = 'col';
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      table.appendChild(head);
      var tbody = el('tbody');
      var rows = data.positions || [];
      if (!rows.length) {
        var empty = el('tr');
        var cell = el('td', '', 'No list clicks recorded yet.');
        cell.colSpan = 4;
        empty.appendChild(cell);
        tbody.appendChild(empty);
      }
      rows.forEach(function (row) {
        var tr = el('tr');
        tr.appendChild(el('td', '', count(row.position)));
        tr.appendChild(el('td', '', count(row.impressions)));
        tr.appendChild(el('td', '', count(row.clicks)));
        tr.appendChild(el('td', '', pct(row.ctr)));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      return table;
    }

    function render() {
      body.textContent = '';
      body.appendChild(kpis());
      body.appendChild(chart());
      body.appendChild(articleTable());
      body.appendChild(positionTable());
      var updated = new Date(data.generatedAt);
      body.appendChild(el(
        'p',
        'nx-dash__note',
        'Updated ' + (isNaN(updated.getTime()) ? '' : updated.toLocaleString()) +
          '. First-party beacons only; readers are counted per day.'
      ));
    }

    select.addEventListener('change', function () { load(select.value); });
    load(select.value);
  }

  ready(dashboard);
}());
