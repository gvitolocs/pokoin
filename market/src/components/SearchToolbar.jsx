import { PRINT_LANGS, setPrintLang, usePrintLang } from '../locale.js';

function FieldLabel({ compact, children }) {
  if (compact) {
    return <span className="sr-only">{children}</span>;
  }
  return children;
}

export default function SearchToolbar({
  sort,
  onSort,
  type,
  onType,
  rarity,
  onRarity,
  rarities = [],
  setName,
  onSet,
  sets = [],
  filtersOn,
  onClear,
  compact = false,
  showPrint = false,
}) {
  const printLang = usePrintLang();
  return (
    <div className="toolbar-right">
      {showPrint ? (
        <label className="sort">
          <FieldLabel compact={compact}>Print</FieldLabel>
          <select
            aria-label="Card print"
            value={printLang}
            onChange={(event) => setPrintLang(event.target.value)}
          >
            {PRINT_LANGS.map((item) => (
              <option key={item.code} value={item.code}>{item.label}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="sort">
        <FieldLabel compact={compact}>Sort</FieldLabel>
        <select value={sort} onChange={(event) => onSort(event.target.value)}>
          <option value="match">Best match</option>
          <option value="pokedex">Pokédex</option>
          <option value="price-asc">Price: low</option>
          <option value="price-desc">Price: high</option>
          <option value="name">Name</option>
        </select>
      </label>
      {typeof onType === 'function' ? (
        <label className="sort">
          <FieldLabel compact={compact}>Type</FieldLabel>
          <select value={type} onChange={(event) => onType(event.target.value)}>
            <option value="all">All</option>
            <option value="singles">Singles</option>
            <option value="sealed">Sealed</option>
          </select>
        </label>
      ) : null}
      <label className="sort">
        <FieldLabel compact={compact}>Rarity</FieldLabel>
        <select value={rarity} onChange={(event) => onRarity(event.target.value)}>
          <option value="">All</option>
          {rarities.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </label>
      <label className="sort">
        <FieldLabel compact={compact}>Set</FieldLabel>
        <select value={setName} onChange={(event) => onSet(event.target.value)}>
          <option value="">All</option>
          {sets.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </label>
      {filtersOn ? (
        <button className="linkish" type="button" onClick={onClear}>
          Clear
        </button>
      ) : null}
    </div>
  );
}
