// "Create the weekly shopping list" orchestration for the planner.
//
// Pure merge/dedupe logic lives in utils/planning; this module only does the
// IO: load pantry + the current open shopping rows, compute the preview, and
// (on confirm) write the new rows. Reuses the existing plannerApi /
// pantryApi / shoppingListApi — no new backend surface.

import type { WeeklyPlanEntry } from '../types';
import { fetchPantryItems } from './pantryApi';
import { addShoppingItem, fetchShoppingList } from './shoppingListApi';
import {
  buildWeeklyShoppingItems,
  filterAlreadyOnList,
  type PlannedShoppingItem,
} from '../utils/planning';

export interface WeeklyShoppingPreview {
  /** Items that would actually be added (pantry-covered + already-on-list removed). */
  items: PlannedShoppingItem[];
  /** Distinct missing items across the week, BEFORE the open-list dedupe. */
  totalMissing: number;
  /** How many merged items were skipped because they're already on the open list. */
  alreadyOnListCount: number;
}

/**
 * Compute what a "create weekly shopping list" action would add. Pantry items
 * are excluded (handled inside buildWeeklyShoppingItems), items already open on
 * the shopping list are skipped (conservative — never duplicate or guess a
 * quantity bump). Best-effort on the open-list fetch: if it fails we still
 * return the merged list rather than block the user.
 */
export async function loadWeeklyShoppingPreview(
  entries: WeeklyPlanEntry[],
): Promise<WeeklyShoppingPreview> {
  let pantryItems: Awaited<ReturnType<typeof fetchPantryItems>> = [];
  try {
    pantryItems = await fetchPantryItems();
  } catch (e) {
    console.warn('[weeklyShoppingFlow] fetchPantryItems failed:', (e as Error).message);
  }

  const merged = buildWeeklyShoppingItems(entries, pantryItems);

  let existingRows: Awaited<ReturnType<typeof fetchShoppingList>> = [];
  try {
    existingRows = await fetchShoppingList();
  } catch (e) {
    console.warn('[weeklyShoppingFlow] fetchShoppingList failed:', (e as Error).message);
  }

  const items = filterAlreadyOnList(
    merged,
    existingRows.map((r) => ({ name: r.name, unit: r.unit, checked: r.checked })),
  );

  return {
    items,
    totalMissing: merged.length,
    alreadyOnListCount: merged.length - items.length,
  };
}

/**
 * Write the previewed items to the shopping list. Each insert is best-effort
 * so one failure doesn't abort the rest; returns how many rows were written.
 */
export async function commitWeeklyShoppingItems(
  items: PlannedShoppingItem[],
): Promise<number> {
  const results = await Promise.all(
    items.map(async (item) => {
      try {
        await addShoppingItem({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          recipeId: item.recipeId,
          dealId: item.dealId,
          storeName: item.storeName,
          price: item.price,
          isManual: item.isManual,
        });
        return true;
      } catch (e) {
        console.warn(
          '[weeklyShoppingFlow] addShoppingItem failed for',
          item.name,
          ':',
          (e as Error).message,
        );
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}
