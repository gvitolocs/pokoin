// Pokoin News page script: share controls and reader comments.
// Comments: GET/POST https://api.pokoin.com/api/news-comments. The Pokoin
// sign-in token is the host-only `pokoin.auth.token` cookie the marketplace
// writes on pokoin.com; it is sent only to the Pokoin API.
// Reading stats are first-party only (POST https://api.pokoin.com/api/news-event):
// no cookies, no third parties, nothing personal; off under Do Not Track / GPC.
(function () {
  'use strict';

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

  function shareControls() {
    var buttons = document.querySelectorAll('.nx-share__copy');
    for (var i = 0; i < buttons.length; i += 1) {
      (function (button) {
        var original = button.textContent;
        button.addEventListener('click', function () {
          var url = button.getAttribute('data-url') || window.location.href;
          var copy = navigator.clipboard && navigator.clipboard.writeText
            ? navigator.clipboard.writeText(url)
            : Promise.reject(new Error('no clipboard'));
          copy.then(function () {
            button.textContent = 'Copied';
            window.setTimeout(function () { button.textContent = original; }, 2000);
          });
        });
      }(buttons[i]));
    }
    if (navigator.share) {
      var share = document.querySelector('.nx-share');
      if (share) {
        var button = el('button', 'nx-share__share', 'Share');
        button.type = 'button';
        button.addEventListener('click', function () {
          navigator.share({ title: document.title, url: window.location.href });
        });
        share.appendChild(button);
      }
    }
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

  function formatDate(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  function commentItem(comment, pending) {
    var item = el('li', 'nx-comment' + (pending ? ' nx-comment--pending' : ''));
    var meta = el('p', 'nx-comment__meta');
    meta.appendChild(el('strong', '', comment.authorName || 'Pokoin user'));
    if (comment.createdAt) meta.appendChild(document.createTextNode(' · ' + formatDate(comment.createdAt)));
    if (pending) meta.appendChild(el('span', 'nx-comment__status', comment.status === 'held' ? ' · Held for review' : ' · Awaiting moderation'));
    item.appendChild(meta);
    var paragraphs = String(comment.body || '').split(/\n{2,}/);
    for (var i = 0; i < paragraphs.length; i += 1) item.appendChild(el('p', 'nx-comment__body', paragraphs[i]));
    return item;
  }

  function comments() {
    var root = document.querySelector('.nx-comments');
    if (!root || !window.fetch) return;
    var api = root.getAttribute('data-api');
    var articleId = root.getAttribute('data-article-id');
    var articlePath = root.getAttribute('data-article-path');
    var list = root.querySelector('.nx-comments__list');
    var formSlot = root.querySelector('.nx-comments__form');
    var auth = session();
    var heading = root.querySelector('h2');

    function load() {
      var headers = auth ? { Authorization: 'Bearer ' + auth.token } : {};
      fetch(api + '?articleId=' + encodeURIComponent(articleId), { headers: headers, credentials: 'omit' })
        .then(function (response) { return response.ok ? response.json() : Promise.reject(new Error(String(response.status))); })
        .then(function (data) {
          list.textContent = '';
          (data.mine || []).forEach(function (comment) { list.appendChild(commentItem(comment, true)); });
          (data.comments || []).forEach(function (comment) { list.appendChild(commentItem(comment, false)); });
          heading.textContent = data.count ? 'Comments (' + data.count + ')' : 'Comments';
          if (!list.children.length) list.appendChild(el('li', 'nx-comments__empty', 'No comments yet.'));
        })
        .catch(function () {
          list.textContent = '';
          list.appendChild(el('li', 'nx-comments__empty', 'Comments could not be loaded right now.'));
        });
    }

    function signInPrompt() {
      var prompt = el('p', 'nx-comments__signin');
      var link = el('a', '', 'Sign in to Pokoin');
      link.href = '/auth?from=' + encodeURIComponent(articlePath + '#comments');
      link.rel = 'nofollow noopener';
      prompt.appendChild(link);
      prompt.appendChild(document.createTextNode(' to join the conversation.'));
      formSlot.appendChild(prompt);
    }

    function form() {
      var node = el('form', 'nx-comments__compose');
      var label = el('label', 'nx-comments__label', 'Add a comment');
      label.setAttribute('for', 'nx-comment-body');
      var box = el('textarea');
      box.id = 'nx-comment-body';
      box.maxLength = 1500;
      box.minLength = 2;
      box.rows = 4;
      box.required = true;
      var row = el('div', 'nx-comments__row');
      var status = el('p', 'nx-comments__status');
      status.setAttribute('role', 'status');
      var submit = el('button', 'nx-comments__submit', 'Post comment');
      submit.type = 'submit';
      row.appendChild(status);
      row.appendChild(submit);
      node.appendChild(label);
      node.appendChild(box);
      node.appendChild(row);
      node.addEventListener('submit', function (event) {
        event.preventDefault();
        var body = box.value.trim();
        if (body.length < 2) return;
        submit.disabled = true;
        status.textContent = 'Sending…';
        fetch(api, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token },
          body: JSON.stringify({ articleId: articleId, articlePath: articlePath, body: body }),
        })
          .then(function (response) {
            return response.json().then(function (data) { return { ok: response.ok, data: data }; });
          })
          .then(function (result) {
            if (!result.ok) throw new Error((result.data && result.data.error) || 'Could not post.');
            box.value = '';
            status.textContent = 'Thanks — your comment will appear once it is moderated.';
            var empty = list.querySelector('.nx-comments__empty');
            if (empty) empty.remove();
            list.insertBefore(commentItem(result.data.comment, true), list.firstChild);
          })
          .catch(function (error) { status.textContent = error.message || 'Could not post.'; })
          .then(function () { submit.disabled = false; });
      });
      formSlot.appendChild(node);
    }

    load();
    if (auth) form();
    else signInPrompt();
  }

  // Reading stats for the admin dashboard (/news/dashboard): list impressions
  // and clicks by card position, article views, scroll milestones and active
  // seconds before the tab hides. Batched beacons; never blocks the page.
  var EVENTS_API = 'https://api.pokoin.com/api/news-event';

  function pageViewId() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    var bytes = null;
    if (window.crypto && window.crypto.getRandomValues) bytes = window.crypto.getRandomValues(new Uint8Array(16));
    for (var i = 0; i < 16; i += 1) {
      out += chars.charAt((bytes ? bytes[i] : Math.floor(Math.random() * 256)) % chars.length);
    }
    return out;
  }

  function analytics() {
    var host = window.location.hostname;
    if (host !== 'pokoin.com' && host !== 'www.pokoin.com') return;
    if (navigator.webdriver === true || navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;

    var pv = pageViewId();
    var queue = [];

    function send(body) {
      var sent = false;
      try {
        if (navigator.sendBeacon) sent = navigator.sendBeacon(EVENTS_API, new Blob([body], { type: 'application/json' }));
      } catch (error) { sent = false; }
      if (!sent && window.fetch) {
        fetch(EVENTS_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
          credentials: 'omit',
        }).catch(function () {});
      }
    }

    function flush() {
      while (queue.length) send(JSON.stringify({ events: queue.splice(0, 40) }));
    }

    function track(event, now) {
      event.pv = pv;
      queue.push(event);
      if (now || queue.length >= 20) flush();
    }

    window.setInterval(function () { if (queue.length) flush(); }, 5000);

    // List cards: impression once ≥50% on screen, click on any card link.
    var cards = document.querySelectorAll('.nx-card[data-article-id]');
    var observer = window.IntersectionObserver
      ? new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i += 1) {
          if (!entries[i].isIntersecting) continue;
          var card = entries[i].target;
          observer.unobserve(card);
          track(cardEvent('impression', card), false);
        }
      }, { threshold: 0.5 })
      : null;

    function cardEvent(type, card) {
      return {
        type: type,
        articleId: card.getAttribute('data-article-id'),
        articlePath: card.getAttribute('data-article-path'),
        source: window.location.pathname,
        position: Number(card.getAttribute('data-position')),
      };
    }

    for (var c = 0; c < cards.length; c += 1) {
      (function (card, position) {
        card.setAttribute('data-position', String(position));
        if (observer) observer.observe(card);
        var links = card.querySelectorAll('a[href]');
        for (var l = 0; l < links.length; l += 1) {
          links[l].addEventListener('click', function () { track(cardEvent('click', card), true); });
          links[l].addEventListener('auxclick', function (event) {
            if (event.button === 1) track(cardEvent('click', card), true);
          });
        }
      }(cards[c], c + 1));
    }

    // Article page: view, scroll milestones, active seconds before leaving.
    var article = document.querySelector('article.nx-article[data-article-id]');
    if (!article) return;
    var articleId = article.getAttribute('data-article-id');
    var articlePath = article.getAttribute('data-article-path');
    var referrerHost = '';
    try { referrerHost = document.referrer ? new URL(document.referrer).hostname : ''; } catch (error) { referrerHost = ''; }
    track({ type: 'view', articleId: articleId, articlePath: articlePath, source: referrerHost }, true);

    var milestones = [25, 50, 75, 100];
    var reached = {};
    var maxDepth = 0;
    var pending = false;

    function measure() {
      pending = false;
      var rect = article.getBoundingClientRect();
      var seen = window.innerHeight - rect.top;
      var pct = rect.height > 0 ? Math.max(0, Math.min(100, (seen / rect.height) * 100)) : 100;
      if (pct > maxDepth) maxDepth = pct;
      for (var m = 0; m < milestones.length; m += 1) {
        var mark = milestones[m];
        if (reached[mark] || maxDepth < (mark === 100 ? 98 : mark)) continue;
        reached[mark] = true;
        track({ type: 'read', articleId: articleId, articlePath: articlePath, depth: mark }, false);
      }
    }

    function schedule() {
      if (pending) return;
      pending = true;
      window.setTimeout(measure, 100);
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    measure();

    var activeMs = 0;
    var visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
    var lastSentSeconds = -1;

    function leave() {
      measure();
      if (visibleSince !== null) {
        activeMs += Date.now() - visibleSince;
        visibleSince = null;
      }
      var seconds = Math.round(activeMs / 1000);
      if (seconds !== lastSentSeconds) {
        lastSentSeconds = seconds;
        track({ type: 'leave', articleId: articleId, articlePath: articlePath, seconds: seconds, depth: Math.round(maxDepth) }, false);
      }
      flush();
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') leave();
      else if (visibleSince === null) visibleSince = Date.now();
    });
    window.addEventListener('pagehide', leave);
  }

  ready(function () {
    shareControls();
    comments();
    try { analytics(); } catch (error) { /* stats must never break the page */ }
  });
}());
