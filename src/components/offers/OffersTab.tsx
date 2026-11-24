import { useMemo, useState } from 'react';
import { IngestProgress, LocationFilter, Offer } from '../../types/models';
import { OfferCard } from './OfferCard';
import { OfferFilters } from './OfferFilters';
import { OfferFiltersState } from './types';

interface OffersTabProps {
  offers: Offer[];
  visibleOffers: Offer[];
  filters: OfferFiltersState;
  locationFilter: LocationFilter;
  ingestLoading: boolean;
  ingestProgress: IngestProgress;
  ingestError: string | null;
  ingestWarnings: string[];
  onFiltersChange: (next: OfferFiltersState) => void;
  onLocationFilterChange: (next: LocationFilter) => void;
  onRequestGps: () => Promise<void>;
  onRefreshOffers: () => Promise<void>;
  onAddToShoppingList: (offer: Offer) => void;
}

function collectOptions(offers: Offer[]): {
  stores: string[];
  categories: string[];
  tags: string[];
} {
  const storeSet = new Set<string>();
  const categorySet = new Set<string>();
  const tagSet = new Set<string>();

  for (const offer of offers) {
    storeSet.add(offer.storeChain);
    categorySet.add(offer.category);
    for (const tag of offer.tags) {
      tagSet.add(tag);
    }
  }

  return {
    stores: [...storeSet].sort((left, right) => left.localeCompare(right, 'de')),
    categories: [...categorySet].sort((left, right) =>
      left.localeCompare(right, 'de'),
    ),
    tags: [...tagSet].sort((left, right) => left.localeCompare(right, 'de')),
  };
}

function formatProgress(progress: IngestProgress): string {
  if (!progress.total || !progress.completed) {
    return progress.message;
  }
  const percentage = Math.round((progress.completed / progress.total) * 100);
  return `${progress.message} (${percentage}%)`;
}

export function OffersTab({
  offers,
  visibleOffers,
  filters,
  locationFilter,
  ingestLoading,
  ingestProgress,
  ingestError,
  ingestWarnings,
  onFiltersChange,
  onLocationFilterChange,
  onRequestGps,
  onRefreshOffers,
  onAddToShoppingList,
}: OffersTabProps) {
  const options = useMemo(() => collectOptions(offers), [offers]);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const localOfferCount = useMemo(
    () => offers.filter((offer) => offer.sourceScope === 'local' || offer.storeId).length,
    [offers],
  );

  const mapGroups = useMemo(() => {
    const grouped = new Map<string, Offer[]>();
    for (const offer of visibleOffers) {
      const storeOffers = grouped.get(offer.storeChain) ?? [];
      storeOffers.push(offer);
      grouped.set(offer.storeChain, storeOffers);
    }
    return [...grouped.entries()];
  }, [visibleOffers]);

  return (
    <div className="tab-layout offers-layout">
      <section className="hero-panel offers-hero">
        <p className="eyebrow">Tab 1</p>
        <h2>Angebote</h2>
        <p className="small-copy">
          {visibleOffers.length} von {offers.length} Angeboten aus{' '}
          {options.stores.length} Maerkten. Lokal: {localOfferCount}.
        </p>
        <div className="hero-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => onRefreshOffers()}
            disabled={ingestLoading}
          >
            {ingestLoading ? 'Laedt Angebote...' : 'Angebote neu laden'}
          </button>
          <div className="inline-controls">
            <button
              type="button"
              className={`mini-button ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              Liste
            </button>
            <button
              type="button"
              className={`mini-button ${viewMode === 'map' ? 'active' : ''}`}
              onClick={() => setViewMode('map')}
            >
              Karte
            </button>
          </div>
        </div>
        {ingestLoading ? <p className="status">{formatProgress(ingestProgress)}</p> : null}
        {ingestError ? <p className="status error">{ingestError}</p> : null}
        {ingestWarnings.length > 0 ? (
          <div className="status warning">
            {ingestWarnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}
      </section>

      <div className="offers-workspace">
        <aside className="offers-sidebar">
          <section className="panel location-panel">
            <h3>Standort</h3>
            <div className="location-options">
              <label className="radio-row">
                <input
                  type="radio"
                  checked={locationFilter.mode === 'none'}
                  onChange={() =>
                    onLocationFilterChange({
                      ...locationFilter,
                      mode: 'none',
                    })
                  }
                />
                Ohne Standort
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  checked={locationFilter.mode === 'postalCode'}
                  onChange={() =>
                    onLocationFilterChange({
                      ...locationFilter,
                      mode: 'postalCode',
                    })
                  }
                />
                Mit PLZ
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  checked={locationFilter.mode === 'gps'}
                  onChange={() =>
                    onLocationFilterChange({
                      ...locationFilter,
                      mode: 'gps',
                    })
                  }
                />
                Mit GPS
              </label>
            </div>

            {locationFilter.mode === 'postalCode' ? (
              <label>
                PLZ
                <input
                  type="text"
                  maxLength={5}
                  value={locationFilter.postalCode}
                  onChange={(event) =>
                    onLocationFilterChange({
                      ...locationFilter,
                      postalCode: event.target.value.replace(/[^\d]/g, ''),
                    })
                  }
                />
              </label>
            ) : null}

            {locationFilter.mode === 'gps' ? (
              <div className="gps-row">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onRequestGps()}
                >
                  GPS Standort verwenden
                </button>
                <p className="small-copy">
                  Radius {locationFilter.radiusKm} km -{' '}
                  {locationFilter.latitude !== null &&
                  locationFilter.longitude !== null
                    ? `lat ${locationFilter.latitude.toFixed(3)}, lon ${locationFilter.longitude.toFixed(3)}`
                    : 'noch nicht gesetzt'}
                </p>
              </div>
            ) : null}
          </section>

          <OfferFilters
            filters={filters}
            stores={options.stores}
            categories={options.categories}
            tags={options.tags}
            onChange={onFiltersChange}
          />
        </aside>

        <section className="panel offers-list-panel">
          <div className="offers-list-head">
            <h3>Angebote dieser Woche</h3>
            <p className="small-copy">Ansicht: {viewMode === 'list' ? 'Liste' : 'Karte'}</p>
          </div>
          {viewMode === 'list' ? (
            visibleOffers.length === 0 ? (
              <p className="empty-state">Keine Angebote passend zu den Filtern gefunden.</p>
            ) : (
              <div className="offer-grid">
                {visibleOffers.map((offer) => (
                  <OfferCard key={offer.id} offer={offer} onAdd={onAddToShoppingList} />
                ))}
              </div>
            )
          ) : (
            <div className="map-placeholder">
              <p>Kartenansicht vorbereitet (ohne externes Map SDK).</p>
              <ul>
                {mapGroups.map(([storeChain, storeOffers]) => {
                  const withCoordinates = storeOffers.find(
                    (offer) =>
                      offer.latitude !== undefined && offer.longitude !== undefined,
                  );
                  return (
                    <li key={storeChain}>
                      {storeChain}: {storeOffers.length} Angebote
                      {withCoordinates ? (
                        <span>
                          {' '}
                          - {withCoordinates.latitude?.toFixed(3)},{' '}
                          {withCoordinates.longitude?.toFixed(3)}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
