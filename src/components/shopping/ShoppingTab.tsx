import { ShoppingListItem } from '../../types/models';
import { ShoppingListSection } from './ShoppingListSection';

interface ShoppingTabProps {
  items: ShoppingListItem[];
  onToggle: (id: string) => void;
  onUpdate: (id: string, patch: Partial<ShoppingListItem>) => void;
  onRemove: (id: string) => void;
}

function countOpenItems(items: ShoppingListItem[]): number {
  return items.filter((item) => !item.checked).length;
}

export function ShoppingTab({
  items,
  onToggle,
  onUpdate,
  onRemove,
}: ShoppingTabProps) {
  const openItems = countOpenItems(items);

  return (
    <div className="tab-layout">
      <section className="hero-panel">
        <p className="eyebrow">Tab 2</p>
        <h2>Einkaufsliste</h2>
        <p className="small-copy">
          {openItems} offene Eintraege von insgesamt {items.length}.
        </p>
      </section>

      <ShoppingListSection
        items={items}
        onToggle={onToggle}
        onUpdate={onUpdate}
        onRemove={onRemove}
      />
    </div>
  );
}
