import { useEffect, useRef, useState } from 'react';
import { flagSrc } from '../locale.js';

function Flag({ code }) {
  return <img src={flagSrc(code)} alt="" width="16" height="16" />;
}

export default function ListingLangPick({ value, listed, redirects, onChange, onRedirect }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(code) {
    setOpen(false);
    const jump = (redirects || []).find((row) => row.code === code);
    if (jump) onRedirect(jump);
    else onChange(code);
  }

  return (
    <div className={`lang-pick${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="lang-pick-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language ${value}`}
        onClick={() => setOpen((next) => !next)}
      >
        <Flag code={value} />
        <span>{value}</span>
      </button>
      {open ? (
        <ul className="lang-pick-menu" role="listbox">
          {(listed || []).map((code) => (
            <li key={code}>
              <button type="button" role="option" aria-selected={code === value} onClick={() => pick(code)}>
                <Flag code={code} />
                <span>{code}</span>
                {code === value ? <em aria-hidden="true">✓</em> : null}
              </button>
            </li>
          ))}
          {(redirects || []).map((row) => (
            <li key={row.code}>
              <button type="button" role="option" aria-selected={false} onClick={() => pick(row.code)}>
                <Flag code={row.code} />
                <span>{row.code}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
