/**
 * The CardGTS glyphs: inline stroke SVGs on the 24 grid that take the text
 * colour, the same shape of component the pricer desk uses
 * (solid/src/components/pricer/icons.jsx). Every one is decorative — the button
 * or link that holds it names itself with its visible text or `aria-label`.
 */
function Glyph(props) {
  return (
    <svg
      class={['buysell-glyph', props.class]}
      viewBox="0 0 24 24"
      width={props.size || 18}
      height={props.size || 18}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

/** Seek: a magnifier. */
export function SearchGlyph(props) {
  return (
    <Glyph {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.4 15.4 4.6 4.6" />
    </Glyph>
  );
}

/** Offer: a parcel. */
export function BoxGlyph(props) {
  return (
    <Glyph {...props}>
      <path d="M12 3.2 4 7.2v9.6l8 4 8-4V7.2z" />
      <path d="M4 7.2 12 11.3l8-4.1M12 11.3v9.5" />
    </Glyph>
  );
}

/** Time left, and the recent sort: a clock. */
export function ClockGlyph(props) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.4V12l3.3 2" />
    </Glyph>
  );
}

/** Copies wanted: two cards, one behind the other. */
export function CopiesGlyph(props) {
  return (
    <Glyph {...props}>
      <rect x="4" y="7" width="11" height="13" rx="2" />
      <path d="M7.5 4h9A2.5 2.5 0 0 1 19 6.5v10" />
    </Glyph>
  );
}

/** The buyer: a person. */
export function BuyerGlyph(props) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M5.4 20.4c0-3.4 2.9-5.6 6.6-5.6s6.6 2.2 6.6 5.6" />
    </Glyph>
  );
}

/** My offers history: a list. */
export function ListGlyph(props) {
  return (
    <Glyph {...props}>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <circle cx="4.6" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** How the trade works: an i in a circle. */
export function InfoGlyph(props) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 11v5.4" />
      <circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Edit: a pencil. */
export function PencilGlyph(props) {
  return (
    <Glyph {...props}>
      <path d="M4 20h4l10.6-10.6a2.1 2.1 0 0 0 0-3l-1-1a2.1 2.1 0 0 0-3 0L4 16z" />
      <path d="m13.6 6.4 4 4" />
    </Glyph>
  );
}

/** Delete: a bin. */
export function BinGlyph(props) {
  return (
    <Glyph {...props}>
      <path d="M4.8 7h14.4M10 7V5.6a1.2 1.2 0 0 1 1.2-1.2h1.6A1.2 1.2 0 0 1 14 5.6V7" />
      <path d="M6.6 7 7.5 19.4a1.8 1.8 0 0 0 1.8 1.6h5.4a1.8 1.8 0 0 0 1.8-1.6L17.4 7" />
      <path d="M10.5 11v5.6M13.5 11v5.6" />
    </Glyph>
  );
}

/** The card page: a window with an arrow out. */
export function OpenGlyph(props) {
  return (
    <Glyph {...props}>
      <path d="M14 4.5h5.5V10" />
      <path d="m19.5 4.5-8.4 8.4" />
      <path d="M17.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 5 6.5h4.4" />
    </Glyph>
  );
}

/** Highest price, and a listed price: a tag. */
export function TagGlyph(props) {
  return (
    <Glyph {...props}>
      <path d="M4 12.5 11.3 5.2h7.5v7.5L11.3 20.2z" />
      <circle cx="15.4" cy="8.6" r="1.2" />
    </Glyph>
  );
}

/** Close a disclosure: an ×. */
export function CloseGlyph(props) {
  return (
    <Glyph {...props}>
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
    </Glyph>
  );
}
