import { supabase } from '../config/supabase';
import type { ShoppingListItem } from '../types';

interface SupabaseShoppingRow {
  id: string;
  name: string;
  quantity: number | string;
  unit: string | null;
  store_name: string | null;
  price: number | string | null;
  deal_id: string | null;
  recipe_id: string | null;
  checked: boolean;
  is_manual: boolean;
  purchased_at: string | null;
  pantry_item_id: string | null;
  created_at: string;
}

function mapRow(row: SupabaseShoppingRow): ShoppingListItem {
  return {
    id: row.id,
    name: row.name,
    quantity: Number(row.quantity ?? 0),
    unit: row.unit ?? '',
    storeName: row.store_name ?? undefined,
    price: row.price != null ? Number(row.price) : undefined,
    dealId: row.deal_id ?? undefined,
    recipeId: row.recipe_id ?? undefined,
    checked: Boolean(row.checked),
    isManual: Boolean(row.is_manual),
    purchasedAt: row.purchased_at ?? undefined,
    pantryItemId: row.pantry_item_id ?? undefined,
    createdAt: row.created_at,
  };
}

async function getUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Nicht angemeldet');
  return user.id;
}

export async function fetchShoppingList(): Promise<ShoppingListItem[]> {
  const userId = await getUserId();
  const { data, error } = await supabase
    .from('shopping_list_items')
    .select('id, name, quantity, unit, store_name, price, deal_id, recipe_id, checked, is_manual, purchased_at, pantry_item_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as SupabaseShoppingRow[]).map(mapRow);
}

export interface AddShoppingItemInput {
  name: string;
  quantity?: number;
  unit?: string;
  storeName?: string;
  price?: number;
  /**
   * Source-deal reference. If the value isn't a valid UUID it's silently
   * dropped to null on the way to Postgres (the column is uuid-typed) —
   * see `isUuid` below. `storeName`/`price` are kept either way so the
   * shopping row still reflects the deal's data.
   *
   * Backend offer IDs (Express categorizer, e.g. "mg_21652062") are *not*
   * UUIDs and don't reference public.deals — that's why this guard exists.
   */
  dealId?: string;
  recipeId?: string;
  /**
   * Override the is_manual heuristic. Use `false` when the row originates
   * from a deal/recipe even if the FK ID can't be persisted (non-UUID).
   * Defaults to "true if neither recipeId nor dealId was provided".
   */
  isManual?: boolean;
}

// Classic 8-4-4-4-12 hex UUID. Tolerant about case; rejects everything else.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export async function addShoppingItem(input: AddShoppingItemInput): Promise<ShoppingListItem> {
  const userId = await getUserId();
  // Heuristic uses the ORIGINAL dealId (intent), not the stripped one,
  // so a deal-driven add stays non-manual even when the FK isn't a UUID.
  const isManual = input.isManual ?? (!input.recipeId && !input.dealId);
  const payload = {
    user_id: userId,
    name: input.name.trim(),
    quantity: input.quantity ?? 1,
    unit: input.unit ?? '',
    store_name: input.storeName ?? null,
    price: input.price ?? null,
    deal_id: isUuid(input.dealId) ? input.dealId : null,
    recipe_id: isUuid(input.recipeId) ? input.recipeId : null,
    checked: false,
    is_manual: isManual,
  };
  const { data, error } = await supabase
    .from('shopping_list_items')
    .insert(payload)
    .select('id, name, quantity, unit, store_name, price, deal_id, recipe_id, checked, is_manual, purchased_at, pantry_item_id, created_at')
    .single();
  if (error) throw error;
  return mapRow(data as SupabaseShoppingRow);
}

export async function deleteShoppingItem(id: string): Promise<void> {
  const { error } = await supabase
    .from('shopping_list_items')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

export async function uncheckShoppingItem(id: string): Promise<ShoppingListItem> {
  const { data, error } = await supabase
    .from('shopping_list_items')
    .update({ checked: false, purchased_at: null, pantry_item_id: null })
    .eq('id', id)
    .select('id, name, quantity, unit, store_name, price, deal_id, recipe_id, checked, is_manual, purchased_at, pantry_item_id, created_at')
    .single();
  if (error) throw error;
  return mapRow(data as SupabaseShoppingRow);
}

/**
 * Atomic-ish "check off + create pantry item" operation.
 * 1) INSERT into pantry_items (source=shopping_list, shopping_item_id=this)
 * 2) UPDATE shopping_list_items: checked=true, purchased_at=now(), pantry_item_id
 *
 * If step 2 fails after step 1 we'd have an orphan pantry item, but that's
 * benign — user can manually remove. A proper transaction would need an RPC.
 */
export async function checkOffAndMoveToPantry(
  item: ShoppingListItem,
): Promise<{ updatedShopping: ShoppingListItem; pantryItemId: string }> {
  const userId = await getUserId();

  const { data: pantryInsert, error: pantryError } = await supabase
    .from('pantry_items')
    .insert({
      user_id: userId,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      source: 'shopping_list',
      shopping_item_id: item.id,
      deal_id: item.dealId ?? null,
    })
    .select('id')
    .single();
  if (pantryError) throw pantryError;
  const pantryItemId = (pantryInsert as { id: string }).id;

  const { data: shoppingUpdate, error: updateError } = await supabase
    .from('shopping_list_items')
    .update({
      checked: true,
      purchased_at: new Date().toISOString(),
      pantry_item_id: pantryItemId,
    })
    .eq('id', item.id)
    .select('id, name, quantity, unit, store_name, price, deal_id, recipe_id, checked, is_manual, purchased_at, pantry_item_id, created_at')
    .single();
  if (updateError) throw updateError;

  return {
    updatedShopping: mapRow(shoppingUpdate as SupabaseShoppingRow),
    pantryItemId,
  };
}

export async function clearCheckedShoppingItems(): Promise<number> {
  const userId = await getUserId();
  const { error, count } = await supabase
    .from('shopping_list_items')
    .delete({ count: 'exact' })
    .eq('user_id', userId)
    .eq('checked', true);
  if (error) throw error;
  return count ?? 0;
}
