import { supabase } from './supabase';

export type Lang = 'de' | 'en' | 'tr' | 'it' | 'es' | 'pl';
export const LANGS: Lang[] = ['de', 'en', 'tr', 'it', 'es', 'pl'];
export const LANG_LABELS: Record<Lang, string> = {
  de: 'Deutsch',
  en: 'English',
  tr: 'Türkçe',
  it: 'Italiano',
  es: 'Español',
  pl: 'Polski',
};

export type MultiLangText = Partial<Record<Lang, string>>;

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'sweet_baked' | 'drinks';
export type DealCategory =
  | 'fruits_vegetables' | 'meat_fish' | 'dairy' | 'drinks'
  | 'snacks_sweets' | 'frozen' | 'other';
export type Difficulty = 'easy' | 'medium' | 'advanced';
export type RecipeStatus = 'active' | 'hidden';
// Provenance / review (migration 20260528000001).
export type RecipeSourceType =
  | 'human_verified'
  | 'public_domain_adapted'
  | 'ai_generated'
  | 'ai_adapted';
export type RecipeVerificationStatus = 'draft' | 'reviewed' | 'published';
export type Allergen =
  | 'gluten' | 'lactose' | 'nuts' | 'eggs' | 'soy'
  | 'fish' | 'seafood' | 'sesame';

export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'sweet_baked', 'drinks'];
export const CATEGORIES: DealCategory[] = [
  'fruits_vegetables', 'meat_fish', 'dairy', 'drinks',
  'snacks_sweets', 'frozen', 'other',
];
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'advanced'];
export const ALLERGENS: Allergen[] = [
  'gluten', 'lactose', 'nuts', 'eggs', 'soy', 'fish', 'seafood', 'sesame',
];

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: 'Frühstück', lunch: 'Mittag', dinner: 'Abend',
  sweet_baked: 'Süßes Gebäck', drinks: 'Getränke',
};
export const CATEGORY_LABELS: Record<DealCategory, string> = {
  fruits_vegetables: 'Obst & Gemüse', meat_fish: 'Fleisch & Fisch',
  dairy: 'Milchprodukte', drinks: 'Getränke',
  snacks_sweets: 'Snacks & Süßes', frozen: 'Tiefkühl', other: 'Sonstiges',
};
export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: 'Einfach', medium: 'Mittel', advanced: 'Fortgeschritten',
};
export const ALLERGEN_LABELS: Record<Allergen, string> = {
  gluten: 'Gluten', lactose: 'Laktose', nuts: 'Nüsse', eggs: 'Eier',
  soy: 'Soja', fish: 'Fisch', seafood: 'Meeresfrüchte', sesame: 'Sesam',
};

export const SOURCE_TYPES: RecipeSourceType[] = [
  'human_verified',
  'public_domain_adapted',
  'ai_generated',
  'ai_adapted',
];
export const SOURCE_TYPE_LABELS: Record<RecipeSourceType, string> = {
  human_verified: 'Mensch verifiziert',
  public_domain_adapted: 'Gemeinfrei modernisiert',
  ai_generated: 'KI generiert',
  ai_adapted: 'KI angepasst',
};

export const VERIFICATION_STATUSES: RecipeVerificationStatus[] = [
  'draft',
  'reviewed',
  'published',
];
export const VERIFICATION_STATUS_LABELS: Record<RecipeVerificationStatus, string> = {
  draft: 'Entwurf',
  reviewed: 'Geprüft',
  published: 'Veröffentlicht',
};

export interface RecipeListRow {
  id: string;
  name: MultiLangText;
  meal_type: MealType;
  category: DealCategory;
  difficulty: Difficulty;
  cook_time_minutes: number;
  status: RecipeStatus;
  rating: number | null;
  rating_count: number;
  cooked_count: number;
  image_url: string | null;
  created_at: string;
  updated_at: string;
  source_type?: RecipeSourceType | null;
  verification_status?: RecipeVerificationStatus | null;
  // Provenance/review (migration 20260528000001) + seed metadata
  // (20260529000001). Optional: pre-migration DBs return rows without these,
  // and `listRecipes` retries without `cuisine/tags/diet_flags` when missing.
  ai_notice_required?: boolean | null;
  safety_notes?: string | null;
  calories?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  cuisine?: string | null;
  tags?: string[] | null;
  diet_flags?: string[] | null;
}

// Derived review/quality flags for the admin overview. Pure — same honest
// signals the backend `/admin-v2` recipe panel computes, mirrored here so the
// standalone admin app surfaces them too.
const AI_SOURCE_TYPES = new Set<RecipeSourceType>(['ai_generated', 'ai_adapted']);

export interface RecipeReviewFlags {
  isAi: boolean;
  missingImage: boolean;
  missingNutrition: boolean;
  missingCuisine: boolean;
  /** Only meaningful for AI recipes — a visible AI recipe must carry a notice. */
  missingAiNotice: boolean;
  needsReview: boolean;
}

export function recipeReviewFlags(row: RecipeListRow): RecipeReviewFlags {
  const isAi = row.source_type != null && AI_SOURCE_TYPES.has(row.source_type);
  const missingImage = !(typeof row.image_url === 'string' && row.image_url.trim().length > 0);
  const missingNutrition =
    row.calories == null && row.protein_g == null && row.carbs_g == null && row.fat_g == null;
  const missingCuisine = !(typeof row.cuisine === 'string' && row.cuisine.trim().length > 0);
  // An AI recipe should explicitly carry the in-app notice flag once reviewed.
  const missingAiNotice = isAi && row.ai_notice_required !== true;
  const needsReview =
    row.verification_status === 'draft' || (isAi && row.verification_status !== 'published');
  return { isAi, missingImage, missingNutrition, missingCuisine, missingAiNotice, needsReview };
}

export interface IngredientDraft {
  id?: string;
  name_de: string;
  amount: number;
  unit: string;
  is_potential_deal: boolean;
  allergens: Allergen[];
  is_halal: boolean;
  contains_alcohol: boolean;
}

export interface InstructionDraft {
  id?: string;
  text_de: string;
}

export interface RecipeFull extends RecipeListRow {
  intro: MultiLangText | null;
  default_portions: number;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  ingredients: IngredientDraft[];
  instructions: InstructionDraft[];
  source_type: RecipeSourceType;
  verification_status: RecipeVerificationStatus;
  source_title: string | null;
  source_author: string | null;
  source_year: number | null;
  source_url: string | null;
  source_license: string | null;
  ai_notice_required: boolean;
  safety_notes: string | null;
}

export interface RecipeListFilters {
  search?: string;
  mealType?: MealType;
  category?: DealCategory;
  difficulty?: Difficulty;
  status?: RecipeStatus;
}

// --- Queries ----------------------------------------------------------------

// Columns guaranteed to exist (original recipes table + the provenance/review
// migration that the admin already depended on).
const LIST_BASE_COLUMNS =
  'id, name, meal_type, category, difficulty, cook_time_minutes, status, rating, rating_count, cooked_count, image_url, created_at, updated_at, source_type, verification_status, ai_notice_required, safety_notes, calories, protein_g, carbs_g, fat_g';
// Seed-metadata columns (migration 20260529000001). Selecting them on a DB that
// hasn't applied that migration makes the whole query fail (42703); we retry
// without them so the list still loads with safe defaults.
const LIST_OPTIONAL_COLUMNS = 'cuisine, tags, diet_flags';

function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42703') return true;
  const message = (error.message ?? '').toLowerCase();
  return (
    message.includes('column') &&
    (message.includes('does not exist') || message.includes('schema cache'))
  );
}

export async function listRecipes(filters: RecipeListFilters = {}): Promise<RecipeListRow[]> {
  const runQuery = (columns: string) => {
    let q = supabase
      .from('recipes')
      .select(columns)
      .order('created_at', { ascending: false })
      .limit(500);
    if (filters.mealType)   q = q.eq('meal_type', filters.mealType);
    if (filters.category)   q = q.eq('category', filters.category);
    if (filters.difficulty) q = q.eq('difficulty', filters.difficulty);
    if (filters.status)     q = q.eq('status', filters.status);
    if (filters.search?.trim()) {
      const s = filters.search.trim().toLowerCase();
      q = q.ilike('name->>de', `%${s}%`);
    }
    return q;
  };

  const full = await runQuery(`${LIST_BASE_COLUMNS}, ${LIST_OPTIONAL_COLUMNS}`);
  if (full.error) {
    if (isMissingColumnError(full.error)) {
      const base = await runQuery(LIST_BASE_COLUMNS);
      if (base.error) throw base.error;
      return (base.data ?? []) as unknown as RecipeListRow[];
    }
    throw full.error;
  }
  return (full.data ?? []) as unknown as RecipeListRow[];
}

export async function getRecipe(id: string): Promise<RecipeFull | null> {
  const [recipeRes, ingRes, insRes] = await Promise.all([
    supabase.from('recipes').select('*').eq('id', id).maybeSingle(),
    supabase.from('recipe_ingredients').select('*').eq('recipe_id', id).order('position'),
    supabase.from('recipe_instructions').select('*').eq('recipe_id', id).order('step_number'),
  ]);

  if (recipeRes.error) throw recipeRes.error;
  if (ingRes.error)    throw ingRes.error;
  if (insRes.error)    throw insRes.error;
  if (!recipeRes.data) return null;

  const r = recipeRes.data as Record<string, unknown>;
  const ingredients: IngredientDraft[] = ((ingRes.data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    name_de: ((row.name as MultiLangText)?.de) ?? '',
    amount: Number(row.amount ?? 0),
    unit: (row.unit as string) ?? '',
    is_potential_deal: Boolean(row.is_potential_deal),
    allergens: (row.allergens as Allergen[]) ?? [],
    is_halal: Boolean(row.is_halal),
    contains_alcohol: Boolean(row.contains_alcohol),
  }));
  const instructions: InstructionDraft[] = ((insRes.data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    text_de: ((row.text as MultiLangText)?.de) ?? '',
  }));

  return {
    id: r.id as string,
    name: r.name as MultiLangText,
    intro: (r.intro as MultiLangText | null) ?? null,
    meal_type: r.meal_type as MealType,
    category: r.category as DealCategory,
    difficulty: r.difficulty as Difficulty,
    cook_time_minutes: Number(r.cook_time_minutes ?? 0),
    default_portions: Number(r.default_portions ?? 2),
    image_url: (r.image_url as string | null) ?? null,
    status: r.status as RecipeStatus,
    rating: r.rating as number | null,
    rating_count: Number(r.rating_count ?? 0),
    cooked_count: Number(r.cooked_count ?? 0),
    calories: r.calories as number | null,
    protein_g: r.protein_g as number | null,
    carbs_g: r.carbs_g as number | null,
    fat_g: r.fat_g as number | null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    ingredients,
    instructions,
    // Provenance defaults match the migration's column defaults so an empty
    // legacy row still hydrates to a sensible Draft.
    source_type: (r.source_type as RecipeSourceType | null) ?? 'human_verified',
    verification_status:
      (r.verification_status as RecipeVerificationStatus | null) ?? 'published',
    source_title: (r.source_title as string | null) ?? null,
    source_author: (r.source_author as string | null) ?? null,
    source_year:
      typeof r.source_year === 'number' && Number.isFinite(r.source_year)
        ? (r.source_year as number)
        : null,
    source_url: (r.source_url as string | null) ?? null,
    source_license: (r.source_license as string | null) ?? null,
    ai_notice_required: Boolean(r.ai_notice_required),
    safety_notes: (r.safety_notes as string | null) ?? null,
  };
}

export interface SaveRecipeInput {
  id?: string;
  name: MultiLangText;
  intro?: MultiLangText;
  meal_type: MealType;
  category: DealCategory;
  difficulty: Difficulty;
  cook_time_minutes: number;
  default_portions: number;
  image_url: string | null;
  status: RecipeStatus;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  ingredients: IngredientDraft[];
  instructions: InstructionDraft[];
  source_type: RecipeSourceType;
  verification_status: RecipeVerificationStatus;
  source_title: string | null;
  source_author: string | null;
  source_year: number | null;
  source_url: string | null;
  source_license: string | null;
  ai_notice_required: boolean;
  safety_notes: string | null;
}

export async function saveRecipe(input: SaveRecipeInput): Promise<string> {
  const { id, ingredients, instructions, intro, ...recipeFields } = input;

  // Strings come from controlled <input> elements where "" means "cleared".
  // Persisting "" would clutter the DB and bypass the column being nullable
  // on purpose; normalise to null instead.
  const blankToNull = (v: string | null): string | null => {
    if (v == null) return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const payload = {
    ...recipeFields,
    intro: intro && Object.values(intro).some(Boolean) ? intro : null,
    source_title: blankToNull(recipeFields.source_title),
    source_author: blankToNull(recipeFields.source_author),
    source_url: blankToNull(recipeFields.source_url),
    source_license: blankToNull(recipeFields.source_license),
    safety_notes: blankToNull(recipeFields.safety_notes),
  };

  let recipeId = id;
  if (id) {
    const { error } = await supabase.from('recipes').update(payload).eq('id', id);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from('recipes')
      .insert(payload)
      .select('id')
      .single();
    if (error) throw error;
    recipeId = (data as { id: string }).id;
  }

  if (!recipeId) throw new Error('Recipe ID missing after save');

  // Replace-all strategy for children
  const [delIng, delIns] = await Promise.all([
    supabase.from('recipe_ingredients').delete().eq('recipe_id', recipeId),
    supabase.from('recipe_instructions').delete().eq('recipe_id', recipeId),
  ]);
  if (delIng.error) throw delIng.error;
  if (delIns.error) throw delIns.error;

  if (ingredients.length > 0) {
    const ingRows = ingredients.map((ing, i) => ({
      recipe_id: recipeId,
      position: i,
      name: { de: ing.name_de },
      amount: ing.amount,
      unit: ing.unit,
      is_potential_deal: ing.is_potential_deal,
      allergens: ing.allergens,
      is_halal: ing.is_halal,
      contains_alcohol: ing.contains_alcohol,
    }));
    const { error } = await supabase.from('recipe_ingredients').insert(ingRows);
    if (error) throw error;
  }

  if (instructions.length > 0) {
    const insRows = instructions.map((step, i) => ({
      recipe_id: recipeId,
      step_number: i + 1,
      text: { de: step.text_de },
    }));
    const { error } = await supabase.from('recipe_instructions').insert(insRows);
    if (error) throw error;
  }

  return recipeId;
}

export async function deleteRecipe(id: string): Promise<void> {
  const { error } = await supabase.from('recipes').delete().eq('id', id);
  if (error) throw error;
}

export async function setRecipeStatus(id: string, status: RecipeStatus): Promise<void> {
  const { error } = await supabase.from('recipes').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function uploadRecipeImage(recipeId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const path = `${recipeId}/main-${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from('recipe-images')
    .upload(path, file, { upsert: true, contentType: file.type });
  if (uploadError) throw uploadError;
  const { data } = supabase.storage.from('recipe-images').getPublicUrl(path);
  return data.publicUrl;
}
