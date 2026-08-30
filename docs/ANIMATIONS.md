# Rare Candy motion → Pokoin landing

Live reference: [get.rarecandy.com](https://get.rarecandy.com/). That site is Webflow. Almost none of the landing motion is CSS `@keyframes`. The engine is **Webflow IX2** in `webflow.schunk.*.js` (`actionLists` + `SCROLL_INTO_VIEW` events).

Pokoin ports those timings in `home/landing.css` + `home/landing.js`. Accent stays Pokoin gold `#FFD33D`. Copy stays honest. We do **not** load Webflow JS.

---

## Tools that extract animations (what they actually see)

| Tool | What it captures | Gap on this site |
| --- | --- | --- |
| [SkillUI](https://github.com/amaancoderx/skillui) `skillui --url … --mode ultra` | Playwright: CSS `@keyframes`, hover/focus diffs, GSAP/Lottie/`window.*` libs, scroll screenshots → `ANIMATIONS.md` | IX2 is not GSAP and not keyframes. Ultra mode would miss the real motion. |
| [design-scan](https://github.com/shawnchee/design-scan) | Playwright `element.getAnimations()`, computed styles, `@keyframes` → `design.md` | Same: Webflow transforms are JS-driven, so `getAnimations()` is empty unless you wait mid-scroll. |
| [PicassoWeb](https://github.com/blackridder22/PicassoWeb) `extract_animations` | Keyframes, library names, scroll-reveal class diffs | Same. |
| Chrome DevTools → Animations panel | WAAPI / CSS animations that actually run | Useful live; still will not dump IX2 JSON. |
| What we used | Fetch HTML + Webflow CSS + the IX2 chunk; parse `actionLists` / presets | This is the source of truth for get.rarecandy.com. |

CSS on that origin has **one** `@keyframes`: `spin` (`.8s linear infinite`) — the Webflow preloader. Ignore it.

---

## IX2 inventory (homepage + shared bundle)

Decoded from `actionLists` in the live Webflow chunk.

### 1. `slideInBottom` (preset `SLIDE_EFFECT`)

Used on most blocks (`SCROLL_INTO_VIEW`).

| Property | Value |
| --- | --- |
| Initial | `opacity: 0`, `translateY(100px)` |
| End | `opacity: 1`, `translateY(0)` |
| Duration | `1000ms` |
| Easing | `outQuart` → `cubic-bezier(0.165, 0.84, 0.44, 1)` |
| Stagger | `0 / 150 / 300 / 450ms` on consecutive cards |
| Some events | `scrollOffsetValue: 20` |

**Pokoin:** `.reveal` / `.is-visible`. Sibling stagger `min(index, 3) * 150`. Hero uses explicit `data-delay`.

### 2. `growIn` (preset `GROW_EFFECT`)

Hero screenshot on Rare Candy (delay `450` on at least one grow).

| Property | Value |
| --- | --- |
| Initial | `opacity: 0`, `scale(0.75)` |
| End | `opacity: 1`, `scale(1)` |
| Duration | `1000ms` |
| Easing | `outQuart` |

**Pokoin:** `.reveal.reveal-grow` on the hero logo (`data-delay="450"`).

### 3. Custom `Fade In On Scroll` (`a-15`, class `.fade-in-on-scroll`)

`useFirstGroupAsInitialState: true`.

| Property | Value |
| --- | --- |
| Initial | `translateY(20px)`, `opacity: 0` |
| Delay | `300ms` |
| Duration | `1200ms` |
| Easing | `ease` |

**Pokoin:** `.reveal.reveal-fade` on section titles and ledes.

### 4. `gallery_marquee` (`a-13`)

| Property | Value |
| --- | --- |
| Property | `translateX(-100%)` of `.gallery_marquee_wrap` |
| Duration | `30000ms` |
| Easing | none (linear) |
| Loop | yes (`loop: true`) |

**Pokoin:** `.marquee-track` `30s linear infinite` to `translateX(-50%)` (two copies of the strip).

### 5. `navbar_color_on_scroll` (`a-14` / `a-18`)

Continuous `PAGE_SCROLL`, smoothing `50`.

| Scroll keyframe | Navbar background |
| --- | --- |
| `1%` | `rgba(0,0,0,0)` |
| `1.1%` | `rgba(0,0,0,0.4)` |
| Duration on the color action | `500ms` |
| CSS | `transition: background-color .2s`, `backdrop-filter: blur(5px)` |

**Pokoin:** `.nav` starts transparent; `.nav.is-scrolled` after `scrollY > 10`. Blur `5px`.

### 6. Navbar hamburger (`a-7` open / `a-8` close)

| Line | Open |
| --- | --- |
| Top | `translateY(8px)` + `rotate(45deg)` |
| Bottom | `translateY(-8px)` + `rotate(-45deg)` |
| Middle | `opacity: 0` |
| Duration | `400ms` |
| Easing | `inOutQuint` → `cubic-bezier(0.86, 0, 0.07, 1)` |

Webflow navbar `data-animation="over-right"` `data-duration="400"`: mobile panel slides in from the right in `400ms`.

**Pokoin:** `.nav-toggle.is-open` spans + `.nav-links` `translateX(100% → 0)` at `≤991px`.

### 7. Store buttons (CSS, not IX2)

```
.button-apple / .button-android { padding: .5rem 1rem; transition: all .15s }
.button-apple:hover { padding: .5rem 1.2rem }
```

**Pokoin:** `.store-btn` and `.cta-box .btn-dark`.

### 8. Nav link color

`transition: color .2s` on `.navbar2_link`.

**Pokoin:** `.nav-links a`.

### 9. Stat count-up (custom JS on their clone / our page)

`[data-count]`, **2000ms**, not in IX2.

**Pokoin:** `animateCounter` in `landing.js`.

### Not on `get.rarecandy.com/` (same JS bundle, other templates)

| List | Motion |
| --- | --- |
| `QNA -> Open/Close` | FAQ height + blur + opacity + chevron rotate (`outExpo` 700–1300ms) |
| `slideInTop` / `growBigIn` | Presets in the engine; not wired on this URL |

We do not have a FAQ accordion, so those lists are not ported.

---

## Mapping on Pokoin

| Rare Candy | Pokoin |
| --- | --- |
| `slideInBottom` | `.reveal` |
| `growIn` | `.reveal.reveal-grow` (hero logo) |
| Fade In On Scroll | `.reveal.reveal-fade` |
| 30s marquee | `.marquee-track` 30s |
| Navbar tint | `.nav.is-scrolled` |
| Hamburger + over-right | `.nav-toggle` + `.nav-links.is-open` |
| Store padding hover | `.store-btn:hover` |
| Counters 2s | `[data-count]` |

Removed vs an earlier Pokoin draft: looping `float-mark` on the logo (Rare Candy does not float the hero shot).

**Nav bar:** transparent glass + `navbar_color_on_scroll`. The blue bloom in the bar is the hero radial (`#4452d8` at `100% 0%`) showing through. Pokoin adds a slow pulse on `.nav-glow` / `.hero-glow` so that bloom reads as live. Logo/links slide in `0.8s` outQuart.

**Footer:** logo, blurb, each column, and the bottom row use `slideInBottom` / fade (Rare Candy `data-w-id` on those nodes starts at opacity 0). Link color `0.2s`.

Kept as Pokoin extras (not in their IX2): gold section glows, gold hover on feature titles.

Hover `translateY` on cards was dropped: it overwrote the 1s slide `transition`.

`prefers-reduced-motion: reduce` still skips reveals, marquee, and the extra hover lifts.
