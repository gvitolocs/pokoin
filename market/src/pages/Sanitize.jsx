import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import manifest from '../../public/review/manifest.json';

const asset = (file) => `${import.meta.env.BASE_URL}review/${file}?v=${manifest.revision}`;

function mapPair(pair) {
  return [
    {
      src: asset(pair.before.file),
      label: pair.before.label,
      caption: pair.before.caption,
      details: pair.before.details || [],
      metrics: pair.before,
    },
    {
      src: asset(pair.after.file),
      label: pair.after.label,
      caption: pair.after.caption,
      details: pair.after.details || [],
      metrics: pair.after,
    },
  ];
}

const SECTIONS = manifest.sections.map((section) => ({
  id: section.id || section.title,
  title: section.title,
  kicker: section.kicker,
  live: section.live,
  note: section.note,
  pairs: (section.pairs || []).map((pair) => mapPair(pair)),
}));

const STRIP = manifest.strip
  ? {
      src: asset(manifest.strip.file),
      label: manifest.strip.label,
      caption: manifest.strip.caption,
    }
  : null;

const DEFERRED = manifest.deferred || [];
const GPU = manifest.gpu || null;

export default function Sanitize() {
  const [guides, setGuides] = useState(true);
  const [zoom, setZoom] = useState(null);
  const zoomRef = useRef(null);

  useEffect(() => {
    document.title = 'Sanitize review · test.pokoin.com';
  }, []);

  useLayoutEffect(() => {
    if (!zoom) {
      return undefined;
    }
    const el = zoomRef.current;
    if (el && !el.open) {
      el.showModal();
    }
    return undefined;
  }, [zoom]);

  return (
    <div className="sanitize">
      <header className="sanitize-bar">
        <a className="brand" href="https://pokoin.com/" aria-label="Pokoin">
          <img src="/home/logo.png" alt="" width="40" height="40" />
          <span>Pokoin</span>
        </a>
        <p className="sanitize-host">
          test.pokoin.com · sanitizer · {manifest.revision}
        </p>
        <label className="sanitize-toggle">
          <input
            type="checkbox"
            checked={guides}
            onChange={(event) => setGuides(event.target.checked)}
          />
          Hairlines
        </label>
      </header>

      <main className="sanitize-main">
        <p className="sanitize-lead">
          Local JPEG review ({manifest.generatedAt.slice(0, 10)}). Not live CDN.
          Charizard leftover only — no CardTrader source. Use hairlines for the
          outer-edge red-line test; compare attack-text sharpness for interior
          artifacts.
        </p>

        {GPU ? (
          <p className="sanitize-note">
            GPU: {GPU.device} · measured bright edge {GPU.measuredBrightDeg}° ·
            applied rotate {GPU.appliedDeg}°
          </p>
        ) : null}

        {SECTIONS.map((section) => (
          <section key={section.id} className="sanitize-block">
            <p className="sanitize-kicker">{section.kicker}</p>
            <h1>{section.title}</h1>
            <p className="sanitize-note">{section.note}</p>
            {section.live ? (
              <p>
                <a href={section.live} target="_blank" rel="noreferrer">
                  Live card 713832
                </a>
              </p>
            ) : null}
            {section.pairs.map((shots, index) => (
              <div key={`${section.id}-${index}`} className="sanitize-pair">
                {shots.map((shot) => (
                  <Shot key={shot.src + shot.label} shot={shot} guides={guides} onZoom={setZoom} />
                ))}
              </div>
            ))}
          </section>
        ))}

        {STRIP ? (
          <section className="sanitize-block">
            <h2>Side-by-side strip</h2>
            <p className="sanitize-note">{STRIP.caption}</p>
            <button
              type="button"
              className="sanitize-strip"
              onClick={() => setZoom(STRIP)}
            >
              <img src={STRIP.src} alt={STRIP.label} />
            </button>
          </section>
        ) : null}

        {DEFERRED.length ? (
          <section className="sanitize-block sanitize-deferred">
            <h2>Held back</h2>
            <p className="sanitize-note">
              Other pipeline samples stay off this page until their border passes
              are fixed.
            </p>
            <ul className="sanitize-deferred-list">
              {DEFERRED.map((entry) => (
                <li key={entry.title}>
                  <strong>{entry.title}</strong>
                  <span>{entry.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

      {zoom ? (
        <dialog
          ref={zoomRef}
          className="zoom"
          onClose={() => setZoom(null)}
          onClick={(event) => {
            if (event.target === zoomRef.current) {
              setZoom(null);
            }
          }}
        >
          <img
            src={zoom.src}
            alt={zoom.label}
            onClick={() => setZoom(null)}
          />
        </dialog>
      ) : null}
    </div>
  );
}

function SkewMetrics({ metrics }) {
  if (!metrics) {
    return null;
  }
  return (
    <>
      {metrics.brightSkewDeg != null ? (
        <span className="sanitize-metric">
          Bright edge: {metrics.brightSkewDeg}°
        </span>
      ) : null}
      {metrics.outerSkewDeg != null ? (
        <span className="sanitize-metric">
          Silhouette: {metrics.outerSkewDeg}°
        </span>
      ) : null}
      {metrics.attackSharpness != null ? (
        <span className="sanitize-metric">
          Attack sharpness: {metrics.attackSharpness}
        </span>
      ) : null}
      {metrics.skewDeg != null && metrics.brightSkewDeg == null ? (
        <span className="sanitize-metric">Skew: {metrics.skewDeg}°</span>
      ) : null}
    </>
  );
}

function Shot({ shot, guides, onZoom }) {
  const { metrics } = shot;
  return (
    <figure className="sanitize-shot">
      <button type="button" className="sanitize-frame" onClick={() => onZoom(shot)}>
        <img src={shot.src} alt={shot.label} />
        {guides ? <span className="sanitize-guides" aria-hidden="true" /> : null}
      </button>
      <figcaption>
        <strong>{shot.label}</strong>
        <span>{shot.caption}</span>
        {shot.details?.length ? (
          <ul className="sanitize-details">
            {shot.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {metrics?.cornerLightSpecks != null ? (
          <span className="sanitize-metric">
            Corner specks: {metrics.cornerLightSpecks}
          </span>
        ) : null}
        <SkewMetrics metrics={metrics} />
      </figcaption>
    </figure>
  );
}
