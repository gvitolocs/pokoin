import { render } from '@solidjs/web';

/**
 * The static landing (index.html) stays plain HTML; this island upgrades two
 * spots with the marketplace's own Solid pieces:
 *
 * - the hero search form gets the header typeahead (createLiveSuggest, the
 *   same engine as SearchBox). The form already works without it: it submits
 *   to /marketplace/search. The engine chunk loads on the first focus.
 * - the Best sellers rail paints the Rust /api/marketplace-home/best-sellers
 *   rail with the marketplace Carousel + CardTile.
 */

function mountSearch(form) {
  const input = form.querySelector('input[name="q"]');
  const host = form.querySelector('[data-landing-suggest]');
  if (!input || !host) return;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    import('./LandingSearch.jsx')
      .then(({ default: LandingSearch }) => {
        render(() => <LandingSearch form={form} input={input} />, host);
      })
      .catch(() => {
        started = false;
      });
  };
  input.addEventListener('focus', start);
  input.addEventListener('pointerenter', start, { once: true });
  input.addEventListener('input', start);
  // Popular searches: fill the field and open the typeahead instead of leaving the page.
  for (const chip of form.parentElement?.querySelectorAll('[data-landing-query]') || []) {
    chip.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
      event.preventDefault();
      input.value = chip.getAttribute('data-landing-query') || '';
      start();
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  if (document.activeElement === input || input.value) start();
}

function mountRail(host) {
  const section = host.closest('section');
  const show = () => {
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
  }, { rootMargin: '600px 0px' });
  observer.observe(host);
}

const form = document.querySelector('[data-landing-search]');
if (form) mountSearch(form);
for (const host of document.querySelectorAll('[data-landing-rail]')) mountRail(host);
