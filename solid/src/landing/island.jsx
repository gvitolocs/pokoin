import { render } from '@solidjs/web';

/**
 * The static landing (index.html) stays plain HTML; this island upgrades two
 * spots with the marketplace's own Solid pieces:
 *
 * - the hero search becomes the marketplace header's SearchBox (game picker,
 *   title-language and print-family pickers, the same popup and ranking). The
 *   static form is its first paint and works without JavaScript: it submits to
 *   /marketplace/search. The box mounts when the page goes idle or on the
 *   first search intent; its ranking engine still loads on focus.
 * - the Best sellers rail paints the Rust /api/marketplace-home/best-sellers
 *   rail with the marketplace Carousel + CardTile.
 * - the hero binder shows a signed-in visitor's own first page (binder.js).
 */

function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2500 });
  else setTimeout(fn, 1200);
}

/** Longest a Popular chip waits for its warmed list before filling the box anyway. */
const CHIP_WAIT_MS = 1500;

/** Idle warming of every Popular chip costs ~200 kB of engine plus their pages: not on slow or metered links. */
function canWarmAtIdle() {
  const link = typeof navigator === 'undefined' ? null : navigator.connection;
  return !(link?.saveData || /(?:^|-)[23]g$/.test(String(link?.effectiveType || '')));
}

function mountSearch(form) {
  let mounted = null;
  let landing = null;
  const start = () => {
    mounted ||= import('./LandingSearch.jsx')
      .then((module) => {
        landing = module;
        const { default: LandingSearch } = module;
        // Carry over what the static field already holds, then swap it out
        // in the same task (no frame shows both).
        const staticInput = form.querySelector('input[name="q"]');
        const typed = staticInput?.value || '';
        const focused = document.activeElement === staticInput;
        const host = document.createElement('div');
        host.className = 'hero-search-host';
        form.before(host);
        render(() => <LandingSearch />, host);
        const input = host.querySelector('input[type="search"]');
        if (!input) {
          host.remove();
          throw new Error('landing search did not render');
        }
        form.remove();
        // The popup opens under a field that sits mid-hero: when its rows would
        // pass the fold (or the phone keyboard), bring the field up first.
        const box = host.querySelector('form');
        box?.addEventListener('focusin', () => {
          if (box.getBoundingClientRect().bottom + Math.min(544, window.innerHeight * 0.6) > window.innerHeight) {
            box.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }
        });
        if (typed) fill(input, typed, focused);
        else if (focused) input.focus();
        return input;
      })
      .catch((error) => {
        mounted = null;
        throw error;
      });
    return mounted;
  };
  const startQuietly = () => {
    start().catch(() => {});
  };
  form.addEventListener('pointerenter', startQuietly, { once: true });
  form.addEventListener('focusin', startQuietly, { once: true });
  form.addEventListener('touchstart', startQuietly, { once: true, passive: true });
  // A picker tapped before the box mounted opens once it has.
  for (const chip of form.querySelectorAll('[data-landing-picker]')) {
    chip.addEventListener('click', () => {
      const name = chip.getAttribute('data-landing-picker');
      start()
        .then((input) => input.closest('form')?.querySelector(`.${name} > button`)?.click())
        .catch(() => {});
    });
  }
  // Popular searches: fill the field and open the typeahead instead of leaving
  // the page. Each chip's query is warmed ahead (SearchBox prewarmSuggest:
  // engine, every suggest page, the results total, then the first thumbnails
  // on hover / focus / touch), so the click paints its final list in one frame.
  const chips = [...(form.parentElement?.querySelectorAll('[data-landing-query]') || [])];
  const warm = (query, thumbs) => start()
    .then(() => (landing?.popularWarmable() ? landing.warmPopular(query, { thumbs }) : null));
  for (const chip of chips) {
    const query = chip.getAttribute('data-landing-query') || '';
    const warmThumbs = () => {
      warm(query, true).catch(() => {});
    };
    chip.addEventListener('pointerenter', warmThumbs, { once: true });
    chip.addEventListener('focus', warmThumbs, { once: true });
    chip.addEventListener('touchstart', warmThumbs, { once: true, passive: true });
    chip.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
      event.preventDefault();
      chip.setAttribute('aria-busy', 'true');
      start()
        .then((input) => {
          if (!landing?.popularWarmable()) {
            fill(input, query, true);
            return undefined;
          }
          const ready = landing.warmPopular(query, { thumbs: true }).catch(() => {});
          return Promise.race([ready, new Promise((resolve) => setTimeout(resolve, CHIP_WAIT_MS))]).then(() => {
            input.focus();
            landing.fillSuggest(input, query);
          });
        })
        .catch(() => window.location.assign(chip.href))
        .finally(() => chip.removeAttribute('aria-busy'));
    });
  }
  whenIdle(startQuietly);
  if (canWarmAtIdle()) {
    // One chip at a time, after the box mounted; a hovered chip jumps the queue on its own.
    whenIdle(() => {
      chips
        .reduce((chain, chip) => chain.then(() => warm(chip.getAttribute('data-landing-query') || '', false)).catch(() => {}), Promise.resolve())
        .catch(() => {});
    });
  }
}

/** Type `value` into the SearchBox input the way a visitor would. */
function fill(input, value, focus) {
  input.value = value;
  if (focus) input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function mountRail(host) {
  const section = host.closest('section');
  let shown = false;
  // Build the rail while the visitor is still on the hero (idle time), not
  // in the frames where they scroll into it: mounting the Carousel and its
  // tiles mid-scroll made arriving at Best sellers / Tools stutter.
  const show = () => {
    if (shown) return;
    shown = true;
    import('./LandingRail.jsx')
      .then(({ default: LandingRail }) => {
        host.textContent = '';
        render(
          () => <LandingRail kind={host.getAttribute('data-landing-rail')} title={host.getAttribute('data-title') || ''} onEmpty={() => { if (section) section.hidden = true; }} />,
          host,
        );
      })
      .catch(() => {
        if (section) section.hidden = true;
      });
  };
  if (typeof IntersectionObserver !== 'function') {
    show();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    show();
  }, { rootMargin: '1200px 0px' });
  observer.observe(host);
  whenIdle(() => {
    observer.disconnect();
    show();
  });
}

// Only a signed-in visitor (landing-boot.js) loads the binder code at all.
const binder = document.querySelector('[data-landing-binder]');
if (binder && document.documentElement.classList.contains('signed-in')) {
  import('./binder.js')
    .then(({ mountBinder }) => mountBinder(binder, { whenIdle }))
    .catch(() => document.documentElement.classList.remove('binder-mine'));
}
const form = document.querySelector('[data-landing-search]');
if (form) mountSearch(form);
for (const host of document.querySelectorAll('[data-landing-rail]')) mountRail(host);
