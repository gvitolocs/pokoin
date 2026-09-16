import { useState } from 'react';
import { setSlug } from '../api.js';
import { setAbbrev } from '../identity.js';
import { expansionCode, expansionSymbolSrc } from '../set-logos.js';

/** Circular / official expansion mark. Falls back to the letter code if the PNG is missing. */
export default function ExpansionMark({ setName, symbolUrl }) {
  const [dead, setDead] = useState(false);
  const slug = setSlug(setName);
  const src = expansionSymbolSrc({ slug, expansionSymbolUrl: symbolUrl });
  const code = expansionCode({ slug, name: setName }) || setAbbrev(setName) || '●';
  if (dead || !src) {
    return <span className="set-shortcut-code">{code}</span>;
  }
  return (
    <img
      className="set-shortcut-sym"
      src={src}
      alt=""
      onError={() => setDead(true)}
    />
  );
}
