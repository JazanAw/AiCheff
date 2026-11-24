import { supabase } from '../config/supabase';
import type {
  Difficulty,
  MealType,
  NutritionInfo,
  Recipe,
  RecipeIngredient,
  RecipeSourceType,
  RecipeVerificationStatus,
  UserPreferences,
} from '../types';

type Lang = 'de' | 'en' | 'tr' | 'it' | 'es' | 'pl';

interface MultiLang {
  de?: string;
  en?: string;
  tr?: string;
  it?: string;
  es?: string;
  pl?: string;
}

interface SupabaseRecipeRow {
  id: string;
  name: MultiLang | null;
  intro: MultiLang | null;
  meal_type: MealType;
  category: string;
  difficulty: Difficulty;
  cook_time_minutes: number;
  default_portions: number;
  image_url: string | null;
  status: 'active' | 'hidden';
  // Recipe metadata (migration 20260529000001). Optional: pre-migration DBs
  // and legacy snapshots can still return rows without these keys.
  cuisine?: string | null;
  tags?: string[] | null;
  diet_flags?: string[] | null;
  halal_status?: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  rating: number | null;
  rating_count: number;
  comment_count: number;
  created_at: string;
  // Optional: migration 20260528000001 added them but pre-deploy DBs and
  // legacy snapshots can still return rows without these keys. Mapping
  // applies safe defaults below.
  source_type?: RecipeSourceType | null;
  verification_status?: RecipeVerificationStatus | null;
  source_title?: string | null;
  source_author?: string | null;
  source_year?: number | null;
  source_url?: string | null;
  source_license?: string | null;
  ai_notice_required?: boolean | null;
  safety_notes?: string | null;
}

const SOURCE_TYPES: RecipeSourceType[] = [
  'human_verified',
  'public_domain_adapted',
  'ai_generated',
  'ai_adapted',
];
const VERIFICATION_STATUSES: RecipeVerificationStatus[] = [
  'draft',
  'reviewed',
  'published',
];

function asSourceType(value: unknown): RecipeSourceType {
  return SOURCE_TYPES.includes(value as RecipeSourceType)
    ? (value as RecipeSourceType)
    : 'human_verified';
}

function asVerificationStatus(value: unknown): RecipeVerificationStatus {
  return VERIFICATION_STATUSES.includes(value as RecipeVerificationStatus)
    ? (value as RecipeVerificationStatus)
    : 'published';
}

interface SupabaseIngredientRow {
  id: string;
  recipe_id: string;
  position: number;
  name: MultiLang | null;
  amount: number;
  unit: string;
  is_potential_deal: boolean;
  allergens: string[] | null;
  is_halal: boolean;
  contains_alcohol: boolean;
}

interface SupabaseInstructionRow {
  recipe_id: string;
  step_number: number;
  text: MultiLang | null;
}

// deal_recipe_matches joined to its deal. PostgREST embeds the to-one deal
// under the `deals` key (FK deal_recipe_matches.deal_id → deals.id).
interface SupabaseDealMatchRow {
  recipe_ingredient_id: string;
  match_score: number | string | null;
  deals: {
    id: string;
    name: string;
    store_name: string;
    current_price: number | string;
    original_price: number | string | null;
    savings_percent: number | string | null;
    image_url: string | null;
    valid_from: string | null;
    valid_to: string;
  } | null;
}

interface DealInfo {
  dealId: string;
  dealName: string;
  storeName: string;
  price: number;
  originalPrice?: number;
  discountPercent?: number;
  imageUrl?: string;
  validFrom?: string;
  validTo: string;
}

function pickText(payload: MultiLang | null | undefined, locale: Lang = 'de'): string {
  if (!payload) return '';
  return payload[locale] ?? payload.de ?? payload.en ?? '';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function mapMealType(value: string | undefined): MealType {
  if (
    value === 'breakfast' ||
    value === 'lunch' ||
    value === 'dinner' ||
    value === 'sweet_baked' ||
    value === 'drinks'
  ) {
    return value;
  }
  return 'lunch';
}

function mapIngredient(
  row: SupabaseIngredientRow,
  locale: Lang,
  deal?: DealInfo,
): RecipeIngredient {
  const ingredient: RecipeIngredient = {
    id: row.id,
    name: pickText(row.name, locale),
    amount: Number(row.amount ?? 0),
    unit: row.unit ?? '',
    // A concrete, currently-valid deal match wins; otherwise fall back to the
    // recipe's own `is_potential_deal` flag (older recipes have no match rows).
    isDeal: deal != null || Boolean(row.is_potential_deal),
  };
  if (deal) {
    ingredient.dealId = deal.dealId;
    ingredient.dealPrice = deal.price;
    ingredient.discountPercent = deal.discountPercent;
    ingredient.dealStoreName = deal.storeName;
    ingredient.dealName = deal.dealName;
    ingredient.dealValidTo = deal.validTo;
    ingredient.dealImageUrl = deal.imageUrl;
    ingredient.dealOriginalPrice = deal.originalPrice;
    ingredient.dealValidFrom = deal.validFrom;
  }
  return ingredient;
}

/**
 * For every recipe ingredient id, find its best currently-valid deal.
 * "Best" = highest match_score, then biggest discount, then lowest price.
 * Only CURRENT deals are attached: expired ones (valid_to < today) AND future /
 * nextWeek ones (valid_from > today) are ignored, so an upcoming offer can never
 * hang off a recipe ingredient as if it were live. Returns an empty map on any
 * error so recipe loading degrades gracefully to the is_potential_deal flag.
 */
async function fetchDealsForIngredients(
  ingredientIds: string[],
): Promise<Map<string, DealInfo>> {
  const byIngredient = new Map<string, DealInfo>();
  if (ingredientIds.length === 0) return byIngredient;

  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('deal_recipe_matches')
    .select(
      'recipe_ingredient_id, match_score, deals(id, name, store_name, current_price, original_price, savings_percent, image_url, valid_from, valid_to)',
    )
    .in('recipe_ingredient_id', ingredientIds);
  if (error) {
    console.warn('[recipesApi] deal match fetch failed:', error.message);
    return byIngredient;
  }

  const candidates = new Map<string, { score: number; info: DealInfo }[]>();
  for (const row of (data ?? []) as unknown as SupabaseDealMatchRow[]) {
    const deal = row.deals;
    if (!deal || deal.valid_to < today) continue;
    // Future / nextWeek deals (valid_from > today) are not live yet — never
    // attach them to a current recipe ingredient. valid_from may be null on
    // legacy rows; only a clearly-future date is excluded.
    if (deal.valid_from && deal.valid_from > today) continue;
    const info: DealInfo = {
      dealId: deal.id,
      dealName: deal.name,
      storeName: deal.store_name,
      price: Number(deal.current_price ?? 0),
      originalPrice:
        deal.original_price != null ? Number(deal.original_price) : undefined,
      discountPercent:
        deal.savings_percent != null ? Number(deal.savings_percent) : undefined,
      imageUrl: deal.image_url ?? undefined,
      validFrom: deal.valid_from ?? undefined,
      validTo: deal.valid_to,
    };
    const list = candidates.get(row.recipe_ingredient_id) ?? [];
    list.push({ score: Number(row.match_score ?? 0), info });
    candidates.set(row.recipe_ingredient_id, list);
  }

  for (const [ingredientId, list] of candidates) {
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const da = a.info.discountPercent ?? 0;
      const db = b.info.discountPercent ?? 0;
      if (db !== da) return db - da;
      return a.info.price - b.info.price;
    });
    byIngredient.set(ingredientId, list[0].info);
  }
  return byIngredient;
}

function buildNutrition(row: SupabaseRecipeRow): NutritionInfo | undefined {
  const calories = row.calories;
  const protein = row.protein_g;
  const carbs = row.carbs_g;
  const fat = row.fat_g;
  if (calories == null && protein == null && carbs == null && fat == null) return undefined;
  return {
    calories: calories ?? undefined,
    protein: protein ?? undefined,
    carbs: carbs ?? undefined,
    fat: fat ?? undefined,
  };
}

export interface FetchRecipesOptions {
  locale?: Lang;
  mealType?: MealType;
  limit?: number;
  preferences?: UserPreferences;
}

// Columns that have existed since the original recipes table
// (20260507000003_recipes.sql). Always safe to select.
const BASE_RECIPE_COLUMNS =
  'id, name, intro, meal_type, category, difficulty, cook_time_minutes, default_portions, image_url, status, calories, protein_g, carbs_g, fat_g, rating, rating_count, comment_count, created_at';

// Columns added by later migrations: provenance/review (20260528000001) and
// seed metadata incl. `cuisine` (20260529000001). If the connected DB hasn't
// had those applied, selecting them makes the ENTIRE query fail (Postgres
// 42703 "column does not exist") — which would blank the whole recipe list and,
// with it, the cuisine filter. We therefore retry without them so recipes still
// load and the mapping falls back to safe defaults.
const OPTIONAL_RECIPE_COLUMNS =
  'cuisine, tags, diet_flags, halal_status, source_type, verification_status, source_title, source_author, source_year, source_url, source_license, ai_notice_required, safety_notes';

function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42703') return true;
  const message = (error.message ?? '').toLowerCase();
  return (
    message.includes('column') &&
    (message.includes('does not exist') || message.includes('schema cache'))
  );
}

export async function fetchRecipes(options: FetchRecipesOptions = {}): Promise<Recipe[]> {
  const locale = options.locale ?? 'de';
  const limit = options.limit ?? 50;

  const runQuery = async (columns: string) => {
    let query = supabase
      .from('recipes')
      .select(columns)
      .eq('status', 'active')
      .order('rating', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (options.mealType) {
      query = query.eq('meal_type', options.mealType);
    }
    return query;
  };

  // Try the full projection first; if an optional column is missing on the
  // target schema, retry with the guaranteed base columns instead of throwing
  // (which previously emptied the whole list, hiding the cuisine filter too).
  let recipeRows: SupabaseRecipeRow[] | null = null;
  const full = await runQuery(`${BASE_RECIPE_COLUMNS}, ${OPTIONAL_RECIPE_COLUMNS}`);
  if (full.error) {
    if (isMissingColumnError(full.error)) {
      console.warn(
        '[recipesApi] optional recipe columns missing — retrying with base columns:',
        full.error.message,
      );
      const base = await runQuery(BASE_RECIPE_COLUMNS);
      if (base.error) throw base.error;
      recipeRows = (base.data ?? []) as unknown as SupabaseRecipeRow[];
    } else {
      throw full.error;
    }
  } else {
    recipeRows = (full.data ?? []) as unknown as SupabaseRecipeRow[];
  }
  if (!recipeRows || recipeRows.length === 0) return [];

  const recipeIds = recipeRows.map((r) => (r as SupabaseRecipeRow).id);

  const [ingRes, insRes] = await Promise.all([
    supabase
      .from('recipe_ingredients')
      .select('id, recipe_id, position, name, amount, unit, is_potential_deal, allergens, is_halal, contains_alcohol')
      .in('recipe_id', recipeIds)
      .order('recipe_id')
      .order('position'),
    supabase
      .from('recipe_instructions')
      .select('recipe_id, step_number, text')
      .in('recipe_id', recipeIds)
      .order('recipe_id')
      .order('step_number'),
  ]);
  // Ingredients/instructions are SECONDARY: `cuisine`, name, image, rating etc.
  // all live on the recipe row itself. A failure here (transient RLS/grant/
  // network) must NOT blank the whole list — otherwise the cuisine filter and
  // chips vanish for a reason unrelated to cuisine. Degrade to empty instead.
  if (ingRes.error) {
    console.warn('[recipesApi] recipe_ingredients fetch failed:', ingRes.error.message);
  }
  if (insRes.error) {
    console.warn('[recipesApi] recipe_instructions fetch failed:', insRes.error.message);
  }

  const ingredientsByRecipe = new Map<string, SupabaseIngredientRow[]>();
  for (const row of (ingRes.data ?? []) as SupabaseIngredientRow[]) {
    const list = ingredientsByRecipe.get(row.recipe_id) ?? [];
    list.push(row);
    ingredientsByRecipe.set(row.recipe_id, list);
  }
  const instructionsByRecipe = new Map<string, SupabaseInstructionRow[]>();
  for (const row of (insRes.data ?? []) as SupabaseInstructionRow[]) {
    const list = instructionsByRecipe.get(row.recipe_id) ?? [];
    list.push(row);
    instructionsByRecipe.set(row.recipe_id, list);
  }

  // Resolve the best valid deal per ingredient via deal_recipe_matches.
  const allIngredientIds = ((ingRes.data ?? []) as SupabaseIngredientRow[]).map(
    (r) => r.id,
  );
  const dealByIngredient = await fetchDealsForIngredients(allIngredientIds);

  const prefs = options.preferences;
  const allergyFilter = prefs?.allergies ?? [];
  const halalFilter = prefs?.halalFilter ?? false;
  const hideAlcohol = prefs?.hideAlcohol ?? false;
  const excludedFoods = (prefs?.excludedFoods ?? []).map((f) => f.toLowerCase());

  const out: Recipe[] = [];
  for (const row of recipeRows as SupabaseRecipeRow[]) {
    const ingredients = (ingredientsByRecipe.get(row.id) ?? []).sort((a, b) => a.position - b.position);

    // Apply user preference filters
    if (allergyFilter.length > 0) {
      const recipeAllergens = new Set<string>();
      for (const ing of ingredients) {
        for (const allergen of ing.allergens ?? []) recipeAllergens.add(allergen);
      }
      if (allergyFilter.some((a) => recipeAllergens.has(a))) continue;
    }
    if (halalFilter && ingredients.some((ing) => ing.is_halal === false)) continue;
    if (hideAlcohol && ingredients.some((ing) => ing.contains_alcohol === true)) continue;
    if (excludedFoods.length > 0) {
      const flat = ingredients.map((ing) => pickText(ing.name, locale).toLowerCase()).join(' | ');
      if (excludedFoods.some((excluded) => flat.includes(excluded))) continue;
    }

    const instructions = (instructionsByRecipe.get(row.id) ?? [])
      .sort((a, b) => a.step_number - b.step_number)
      .map((step) => pickText(step.text, locale))
      .filter((text) => text.length > 0);

    out.push({
      id: row.id,
      name: pickText(row.name, locale) || '(ohne Name)',
      imageUrl: row.image_url ?? undefined,
      difficulty: row.difficulty,
      cookTimeMinutes: row.cook_time_minutes,
      servings: row.default_portions,
      mealType: mapMealType(row.meal_type),
      cuisine: row.cuisine?.trim() || undefined,
      tags: toStringArray(row.tags),
      dietFlags: toStringArray(row.diet_flags),
      halalStatus: row.halal_status?.trim() || undefined,
      ingredients: ingredients.map((ing) =>
        mapIngredient(ing, locale, dealByIngredient.get(ing.id)),
      ),
      instructions,
      introText: pickText(row.intro, locale) || undefined,
      nutritionPerServing: buildNutrition(row),
      rating: row.rating ?? undefined,
      ratingCount: row.rating_count ?? 0,
      commentCount: row.comment_count ?? 0,
      createdAt: row.created_at,
      sourceType: asSourceType(row.source_type),
      verificationStatus: asVerificationStatus(row.verification_status),
      sourceTitle: row.source_title?.trim() || undefined,
      sourceAuthor: row.source_author?.trim() || undefined,
      sourceYear:
        typeof row.source_year === 'number' && Number.isFinite(row.source_year)
          ? row.source_year
          : undefined,
      sourceUrl: row.source_url?.trim() || undefined,
      sourceLicense: row.source_license?.trim() || undefined,
      aiNoticeRequired: Boolean(row.ai_notice_required),
      safetyNotes: row.safety_notes?.trim() || undefined,
    });
  }

  return out;
}
