import { createSignal } from 'solid-js';
import { useNavigate } from '@solidjs/router';

/**
 * Header search (market/src/components/Chrome.jsx search form). This first
 * slice keeps the exact markup and submit behaviour; the typeahead popup lands
 * once market/src/api.js and the suggest modules are React-free.
 */
export default function SearchBox() {
  const navigate = useNavigate();
  const [query, setQuery] = createSignal('');
  const submit = (event) => {
    event.preventDefault();
    const q = query().trim();
    navigate(q ? `/marketplace/search?q=${encodeURIComponent(q)}` : '/marketplace/search');
  };
  return (
    <form class="search" onSubmit={submit} role="search">
      <label class="sr-only" for="market-search">Search cards</label>
      <div class="search-pill">
        <input
          id="market-search"
          type="search"
          role="combobox"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search cards, sets, products..."
          autocomplete="off"
          aria-expanded="false"
          aria-controls="market-suggest"
          aria-autocomplete="list"
        />
        <button class="sr-only" type="submit">Search</button>
      </div>
    </form>
  );
}
