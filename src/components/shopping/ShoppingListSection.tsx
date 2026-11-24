import { ShoppingListItem } from '../../types/models';

interface ShoppingListSectionProps {
  items: ShoppingListItem[];
  onToggle: (id: string) => void;
  onUpdate: (id: string, patch: Partial<ShoppingListItem>) => void;
  onRemove: (id: string) => void;
}

function sortItems(items: ShoppingListItem[]): ShoppingListItem[] {
  return [...items].sort((left, right) => {
    if (left.checked !== right.checked) {
      return Number(left.checked) - Number(right.checked);
    }
    const byStore = (left.storeChain ?? '').localeCompare(right.storeChain ?? '', 'de');
    if (byStore !== 0) {
      return byStore;
    }
    const byCategory = (left.category ?? '').localeCompare(right.category ?? '', 'de');
    if (byCategory !== 0) {
      return byCategory;
    }
    return left.name.localeCompare(right.name, 'de');
  });
}

export function ShoppingListSection({
  items,
  onToggle,
  onUpdate,
  onRemove,
}: ShoppingListSectionProps) {
  const sortedItems = sortItems(items);

  return (
    <section className="panel">
      <h3>Einkaufsliste</h3>
      {sortedItems.length === 0 ? (
        <p className="empty-state">Noch keine Items in der Einkaufsliste.</p>
      ) : (
        <ul className="shopping-list">
          {sortedItems.map((item) => (
            <li key={item.id} className={`shopping-item ${item.checked ? 'checked' : ''}`}>
              <label className="shopping-main">
                <input
                  type="checkbox"
                  checked={item.checked}
                  onChange={() => onToggle(item.id)}
                />
                <span>{item.name}</span>
              </label>

              <div className="shopping-fields">
                <label>
                  Menge
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={item.quantity}
                    onChange={(event) =>
                      onUpdate(item.id, {
                        quantity: Number.parseFloat(event.target.value) || 1,
                      })
                    }
                  />
                </label>
                <label>
                  Einheit
                  <input
                    type="text"
                    value={item.unit}
                    onChange={(event) =>
                      onUpdate(item.id, {
                        unit: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Notiz
                  <input
                    type="text"
                    value={item.note}
                    onChange={(event) =>
                      onUpdate(item.id, {
                        note: event.target.value,
                      })
                    }
                  />
                </label>
              </div>

              <button
                type="button"
                className="ghost-button"
                onClick={() => onRemove(item.id)}
              >
                Entfernen
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
