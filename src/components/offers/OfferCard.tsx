import { Offer } from '../../types/models';

interface OfferCardProps {
  offer: Offer;
  onAdd: (offer: Offer) => void;
}

function formatPrice(value: number, currency: string): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency,
  }).format(value);
}

function formatDate(dateIso: string): string {
  const date = new Date(dateIso);
  return Number.isNaN(date.valueOf())
    ? '-'
    : date.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
}

function formatDistance(distanceKm: number | undefined): string | null {
  if (distanceKm === undefined || !Number.isFinite(distanceKm)) {
    return null;
  }
  return `${distanceKm.toFixed(distanceKm < 10 ? 1 : 0)} km`;
}

export function OfferCard({ offer, onAdd }: OfferCardProps) {
  const isLocal = offer.sourceScope === 'local' || Boolean(offer.storeId);
  const distance = formatDistance(offer.distanceKm);

  return (
    <article className="offer-card">
      <div className="offer-image-wrap">
        <div className="offer-image">
          {offer.imageUrl ? (
            <img src={offer.imageUrl} alt={offer.name} />
          ) : (
            <span>{offer.storeChain}</span>
          )}
        </div>
        <span className="offer-store-chip">{offer.storeChain}</span>
        {isLocal ? <span className="offer-scope-chip">Lokal</span> : null}
      </div>

      <div className="offer-content">
        <div className="offer-top-row">
          <h4>{offer.name}</h4>
          <button
            type="button"
            className="add-button"
            onClick={() => onAdd(offer)}
            aria-label={`${offer.name} zur Liste hinzufuegen`}
          >
            Zur Liste
          </button>
        </div>

        <p className="offer-price">{formatPrice(offer.price, offer.currency)}</p>
        <p className="offer-meta">
          <span className="offer-meta-strong">Kategorie:</span> {offer.category}
        </p>
        {isLocal ? (
          <p className="offer-meta">
            <span className="offer-meta-strong">Quelle:</span> Lokal
            {offer.storeCity ? ` - ${offer.storeCity}` : ''}
            {distance ? ` - ${distance}` : ''}
          </p>
        ) : null}
        <p className="offer-meta">Gueltig bis: {formatDate(offer.validityEnd)}</p>

        {offer.basePrice && offer.baseUnit ? (
          <p className="offer-meta">
            Grundpreis: {formatPrice(offer.basePrice, offer.currency)} / {offer.baseUnit}
          </p>
        ) : null}

        {offer.brand ? <p className="offer-meta">Marke: {offer.brand}</p> : null}

        {offer.tags.length > 0 ? (
          <p className="offer-tags">Tags: {offer.tags.join(', ')}</p>
        ) : null}
      </div>
    </article>
  );
}
