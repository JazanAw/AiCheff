import { ChangeEvent } from 'react';
import { OfferFiltersState } from './types';

interface OfferFiltersProps {
  filters: OfferFiltersState;
  stores: string[];
  categories: string[];
  tags: string[];
  onChange: (next: OfferFiltersState) => void;
}

function toggleTag(current: string[], tag: string): string[] {
  return current.includes(tag)
    ? current.filter((value) => value !== tag)
    : [...current, tag];
}

export function OfferFilters({
  filters,
  stores,
  categories,
  tags,
  onChange,
}: OfferFiltersProps) {
  const onInput =
    (key: keyof OfferFiltersState) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      onChange({
        ...filters,
        [key]: event.target.value,
      });
    };

  return (
    <section className="panel filter-panel">
      <div className="panel-header">
        <h3>Filter</h3>
        <span className="small-copy">{tags.length} Tags</span>
      </div>
      <div className="filter-grid">
        <label>
          Laden
          <select value={filters.store} onChange={onInput('store')}>
            <option value="all">Alle</option>
            {stores.map((store) => (
              <option key={store} value={store}>
                {store}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kategorie
          <select value={filters.category} onChange={onInput('category')}>
            <option value="all">Alle</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quelle
          <select value={filters.scope} onChange={onInput('scope')}>
            <option value="all">Alle</option>
            <option value="national">National</option>
            <option value="local">Lokal</option>
          </select>
        </label>
        <label>
          Suche
          <input
            type="text"
            placeholder="z.B. Tomaten"
            value={filters.search}
            onChange={onInput('search')}
          />
        </label>
      </div>

      <div className="tag-filter-row">
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`tag-chip ${filters.selectedTags.includes(tag) ? 'selected' : ''}`}
            onClick={() =>
              onChange({
                ...filters,
                selectedTags: toggleTag(filters.selectedTags, tag),
              })
            }
          >
            {tag}
          </button>
        ))}
      </div>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={filters.onlyFood}
          onChange={(event) =>
            onChange({
              ...filters,
              onlyFood: event.target.checked,
            })
          }
        />
        Nur Lebensmittel anzeigen
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={filters.onlyCurrentWeek}
          onChange={(event) =>
            onChange({
              ...filters,
              onlyCurrentWeek: event.target.checked,
            })
          }
        />
        Nur Angebote dieser Woche
      </label>
    </section>
  );
}
