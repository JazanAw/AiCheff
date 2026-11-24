import { supabase } from '../config/supabase';
import type {
  NutritionInfo,
  PantryItem,
  PantryLookupSource,
  PantrySource,
} from '../types';

interface SupabasePantryRow {
  id: string;
  name: string;
  quantity: number | string;
  unit: string | null;
  source: PantrySource;
  shopping_item_id: string | null;
  deal_id: string | null;
  added_at: string;
  consumed_at: string | null;
  expires_at: string | null;
  notes: string | null;
  barcode: string | null;
  brand: string | null;
  product_name: string | null;
  category: string | null;
  image_url: string | null;
  nutrition: NutritionInfo | null;
  ingredients_text: string[] | null;
  raw_product_payload: unknown;
  lookup_source: PantryLookupSource | null;
}

// supabase-js types its return value off the *literal* string passed to
// .select(...). Pulling the list into a const variable breaks that
// inference and forces every map call through `unknown`. We keep the
// literal in-place instead — slightly repetitive, but typed end-to-end.
// Keep all six occurrences in sync.

function mapRow(row: SupabasePantryRow): PantryItem {
  return {
    id: row.id,
    name: row.name,
    quantity: Number(row.quantity ?? 0),
    unit: row.unit ?? '',
    source: row.source,
    shoppingItemId: row.shopping_item_id ?? undefined,
    dealId: row.deal_id ?? undefined,
    addedAt: row.added_at,
    consumedAt: row.consumed_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    notes: row.notes ?? undefined,
    barcode: row.barcode ?? undefined,
    brand: row.brand ?? undefined,
    productName: row.product_name ?? undefined,
    category: row.category ?? undefined,
    imageUrl: row.image_url ?? undefined,
    nutrition: row.nutrition ?? undefined,
    ingredientsText:
      row.ingredients_text && row.ingredients_text.length > 0
        ? row.ingredients_text
        : undefined,
    rawProductPayload: row.raw_product_payload ?? undefined,
    lookupSource: row.lookup_source ?? undefined,
  };
}

async function getUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Nicht angemeldet');
  return user.id;
}

export async function fetchPantryItems(
  options: { includeConsumed?: boolean } = {},
): Promise<PantryItem[]> {
  const userId = await getUserId();
  let query = supabase
    .from('pantry_items')
    .select('id, name, quantity, unit, source, shopping_item_id, deal_id, added_at, consumed_at, expires_at, notes, barcode, brand, product_name, category, image_url, nutrition, ingredients_text, raw_product_payload, lookup_source')
    .eq('user_id', userId)
    .order('added_at', { ascending: false });
  if (!options.includeConsumed) {
    query = query.is('consumed_at', null);
  }
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as SupabasePantryRow[]).map(mapRow);
}

export interface AddPantryItemInput {
  name: string;
  quantity?: number;
  unit?: string;
  expiresAt?: string;
  notes?: string;
  barcode?: string;
  brand?: string;
  productName?: string;
  category?: string;
  imageUrl?: string;
  nutrition?: NutritionInfo;
  ingredientsText?: string[];
  rawProductPayload?: unknown;
  lookupSource?: PantryLookupSource;
}

export async function addPantryItem(input: AddPantryItemInput): Promise<PantryItem> {
  const userId = await getUserId();
  const { data, error } = await supabase
    .from('pantry_items')
    .insert({
      user_id: userId,
      name: input.name.trim(),
      quantity: input.quantity ?? 1,
      unit: input.unit ?? '',
      source: 'manual' as PantrySource,
      expires_at: input.expiresAt ?? null,
      notes: input.notes ?? null,
      barcode: input.barcode ?? null,
      brand: input.brand ?? null,
      product_name: input.productName ?? null,
      category: input.category ?? null,
      image_url: input.imageUrl ?? null,
      nutrition: input.nutrition ?? null,
      ingredients_text: input.ingredientsText ?? [],
      raw_product_payload: input.rawProductPayload ?? null,
      lookup_source: input.lookupSource ?? 'manual',
    })
    .select('id, name, quantity, unit, source, shopping_item_id, deal_id, added_at, consumed_at, expires_at, notes, barcode, brand, product_name, category, image_url, nutrition, ingredients_text, raw_product_payload, lookup_source')
    .single();
  if (error) throw error;
  return mapRow(data as SupabasePantryRow);
}

export async function markPantryItemConsumed(id: string): Promise<PantryItem> {
  const { data, error } = await supabase
    .from('pantry_items')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, name, quantity, unit, source, shopping_item_id, deal_id, added_at, consumed_at, expires_at, notes, barcode, brand, product_name, category, image_url, nutrition, ingredients_text, raw_product_payload, lookup_source')
    .single();
  if (error) throw error;
  return mapRow(data as SupabasePantryRow);
}

export async function unmarkPantryItemConsumed(id: string): Promise<PantryItem> {
  const { data, error } = await supabase
    .from('pantry_items')
    .update({ consumed_at: null })
    .eq('id', id)
    .select('id, name, quantity, unit, source, shopping_item_id, deal_id, added_at, consumed_at, expires_at, notes, barcode, brand, product_name, category, image_url, nutrition, ingredients_text, raw_product_payload, lookup_source')
    .single();
  if (error) throw error;
  return mapRow(data as SupabasePantryRow);
}

export async function deletePantryItem(id: string): Promise<void> {
  const { error } = await supabase
    .from('pantry_items')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

/**
 * Lookup the user's active (not-consumed) pantry row for a given barcode.
 * Used by the scanner flow to decide between "create new" and "increment
 * existing". Returns null when no active row matches.
 *
 * Relies on pantry_items_user_barcode_active_idx for the index path.
 */
export async function findActivePantryItemByBarcode(
  barcode: string,
): Promise<PantryItem | null> {
  const trimmed = barcode.trim();
  if (!trimmed) return null;
  const userId = await getUserId();
  const { data, error } = await supabase
    .from('pantry_items')
    .select('id, name, quantity, unit, source, shopping_item_id, deal_id, added_at, consumed_at, expires_at, notes, barcode, brand, product_name, category, image_url, nutrition, ingredients_text, raw_product_payload, lookup_source')
    .eq('user_id', userId)
    .eq('barcode', trimmed)
    .is('consumed_at', null)
    .order('added_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as SupabasePantryRow[];
  if (rows.length === 0) return null;
  return mapRow(rows[0]);
}

/**
 * Read-then-update increment for the "scanned a product I already have"
 * case. Not transactional — two concurrent scans could race. Acceptable for
 * the v1 single-user flow; if it becomes a problem move to a SQL RPC.
 */
export async function incrementPantryItemQuantity(
  id: string,
  deltaQuantity: number,
): Promise<PantryItem> {
  if (!Number.isFinite(deltaQuantity) || deltaQuantity <= 0) {
    throw new Error('deltaQuantity must be > 0');
  }
  const { data: current, error: readError } = await supabase
    .from('pantry_items')
    .select('quantity')
    .eq('id', id)
    .single();
  if (readError) throw readError;
  const currentQuantity = Number((current as { quantity: number | string }).quantity ?? 0);
  const nextQuantity = currentQuantity + deltaQuantity;
  const { data, error } = await supabase
    .from('pantry_items')
    .update({ quantity: nextQuantity })
    .eq('id', id)
    .select('id, name, quantity, unit, source, shopping_item_id, deal_id, added_at, consumed_at, expires_at, notes, barcode, brand, product_name, category, image_url, nutrition, ingredients_text, raw_product_payload, lookup_source')
    .single();
  if (error) throw error;
  return mapRow(data as SupabasePantryRow);
}
