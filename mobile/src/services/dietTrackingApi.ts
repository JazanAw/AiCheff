import { supabase } from '../config/supabase';
import type {
  ActivityLevel,
  BodyData,
  DietGoal,
  DietGoalType,
  Gender,
  MealCategory,
  MealLogEntry,
  ProgressEntry,
} from '../types';

// All persisted diet fields in one flat, camelCase object. Composed from the
// core BodyData fields + the DietGoal fields (which already carries
// goalModeEnabled). The DB splits none of this — it all lives in one
// user_body_data row keyed by user_id.
export type DietBodyData = Partial<BodyData> & DietGoal;

async function getUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Nicht angemeldet');
  return user.id;
}

// ─── user_body_data ─────────────────────────────────────────────────────

interface SupabaseBodyDataRow {
  gender: Gender | null;
  height_cm: number | null;
  weight_kg: number | string | null;
  body_fat_percent: number | string | null;
  activity_level: ActivityLevel | null;
  target_weight_kg: number | string | null;
  target_body_fat_percent: number | string | null;
  daily_calorie_target: number | null;
  auto_calculate_calories: boolean;
  goal_mode_enabled: boolean;
  // Added by 20260531000001_diet_tracking_meals_water.sql. Optional so a
  // pre-migration DB still returns the base row (see BODY_COLS fallback).
  age?: number | null;
  diet_goal_type?: DietGoalType | null;
  training_days_per_week?: number | null;
  protein_target_g?: number | null;
  water_target_ml?: number | null;
}

// Columns guaranteed since the original diet schema (20260507000004).
const BODY_COLS_BASE =
  'gender, height_cm, weight_kg, body_fat_percent, activity_level, target_weight_kg, target_body_fat_percent, daily_calorie_target, auto_calculate_calories, goal_mode_enabled';
// Columns added by 20260531000001. Selecting a missing column fails the whole
// query (Postgres 42703), so we retry with the base set if they're absent.
const BODY_COLS_EXTRA = 'age, diet_goal_type, training_days_per_week, protein_target_g, water_target_ml';
const BODY_COLS = `${BODY_COLS_BASE}, ${BODY_COLS_EXTRA}`;

function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42703') return true;
  const message = (error.message ?? '').toLowerCase();
  return (
    message.includes('column') &&
    (message.includes('does not exist') || message.includes('schema cache'))
  );
}

function mapBody(row: SupabaseBodyDataRow): DietBodyData {
  return {
    gender: row.gender ?? undefined,
    heightCm: row.height_cm ?? undefined,
    weightKg: row.weight_kg != null ? Number(row.weight_kg) : undefined,
    bodyFatPercent:
      row.body_fat_percent != null ? Number(row.body_fat_percent) : undefined,
    activityLevel: row.activity_level ?? undefined,
    age: row.age ?? undefined,
    targetWeightKg:
      row.target_weight_kg != null ? Number(row.target_weight_kg) : undefined,
    targetBodyFatPercent:
      row.target_body_fat_percent != null
        ? Number(row.target_body_fat_percent)
        : undefined,
    dailyCalorieTarget: row.daily_calorie_target ?? undefined,
    autoCalculateCalories: Boolean(row.auto_calculate_calories),
    goalModeEnabled: Boolean(row.goal_mode_enabled),
    goalType: row.diet_goal_type ?? undefined,
    trainingDaysPerWeek: row.training_days_per_week ?? undefined,
    proteinTargetG: row.protein_target_g ?? undefined,
    waterTargetMl: row.water_target_ml ?? undefined,
  };
}

/** The current user's body-data/goal row, or null if they never saved one. */
export async function getBodyData(): Promise<DietBodyData | null> {
  const userId = await getUserId();
  const full = await supabase
    .from('user_body_data')
    .select(BODY_COLS)
    .eq('user_id', userId)
    .maybeSingle();
  let data: unknown = full.data;
  if (full.error) {
    if (!isMissingColumnError(full.error)) throw full.error;
    // Pre-migration DB: retry without the new goal/target columns.
    const base = await supabase
      .from('user_body_data')
      .select(BODY_COLS_BASE)
      .eq('user_id', userId)
      .maybeSingle();
    if (base.error) throw base.error;
    data = base.data;
  }
  if (!data) return null;
  return mapBody(data as SupabaseBodyDataRow);
}

/**
 * Insert-or-update the current user's body-data/goal row. The user_id is
 * always taken from the session — never from the UI — so a caller cannot
 * write another user's row (RLS enforces the same on the server side).
 */
export async function upsertBodyData(input: DietBodyData): Promise<DietBodyData> {
  const userId = await getUserId();
  const basePayload = {
    user_id: userId,
    gender: input.gender ?? null,
    height_cm: input.heightCm ?? null,
    weight_kg: input.weightKg ?? null,
    body_fat_percent: input.bodyFatPercent ?? null,
    activity_level: input.activityLevel ?? null,
    target_weight_kg: input.targetWeightKg ?? null,
    target_body_fat_percent: input.targetBodyFatPercent ?? null,
    daily_calorie_target: input.dailyCalorieTarget ?? null,
    auto_calculate_calories: input.autoCalculateCalories ?? true,
    goal_mode_enabled: input.goalModeEnabled ?? false,
  };
  const extraPayload = {
    age: input.age ?? null,
    diet_goal_type: input.goalType ?? null,
    training_days_per_week: input.trainingDaysPerWeek ?? null,
    protein_target_g: input.proteinTargetG ?? null,
    water_target_ml: input.waterTargetMl ?? null,
  };

  const full = await supabase
    .from('user_body_data')
    .upsert({ ...basePayload, ...extraPayload }, { onConflict: 'user_id' })
    .select(BODY_COLS)
    .single();
  if (!full.error) return mapBody(full.data as SupabaseBodyDataRow);
  if (!isMissingColumnError(full.error)) throw full.error;

  // Pre-migration DB: persist only the columns that exist.
  const base = await supabase
    .from('user_body_data')
    .upsert(basePayload, { onConflict: 'user_id' })
    .select(BODY_COLS_BASE)
    .single();
  if (base.error) throw base.error;
  return mapBody(base.data as SupabaseBodyDataRow);
}

// ─── user_progress_entries ──────────────────────────────────────────────

interface SupabaseProgressRow {
  id: string;
  entry_date: string;
  weight_kg: number | string | null;
  body_fat_percent: number | string | null;
  notes: string | null;
}

const PROGRESS_COLS = 'id, entry_date, weight_kg, body_fat_percent, notes';

function mapProgress(row: SupabaseProgressRow): ProgressEntry {
  return {
    id: row.id,
    date: row.entry_date,
    weightKg: row.weight_kg != null ? Number(row.weight_kg) : undefined,
    bodyFatPercent:
      row.body_fat_percent != null ? Number(row.body_fat_percent) : undefined,
    notes: row.notes ?? undefined,
  };
}

export async function listProgressEntries(limit = 30): Promise<ProgressEntry[]> {
  const userId = await getUserId();
  const { data, error } = await supabase
    .from('user_progress_entries')
    .select(PROGRESS_COLS)
    .eq('user_id', userId)
    .order('entry_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as SupabaseProgressRow[]).map(mapProgress);
}

export interface UpsertProgressEntryInput {
  /** ISO date string, YYYY-MM-DD. Unique per user — re-saving a date updates. */
  date: string;
  weightKg?: number;
  bodyFatPercent?: number;
  notes?: string;
}

/**
 * Insert-or-update one progress entry. (user_id, entry_date) is unique, so
 * saving the same date overwrites that day's row instead of duplicating.
 */
export async function upsertProgressEntry(
  input: UpsertProgressEntryInput,
): Promise<ProgressEntry> {
  const userId = await getUserId();
  const trimmedNotes = input.notes?.trim();
  const payload = {
    user_id: userId,
    entry_date: input.date,
    weight_kg: input.weightKg ?? null,
    body_fat_percent: input.bodyFatPercent ?? null,
    notes: trimmedNotes ? trimmedNotes : null,
  };
  const { data, error } = await supabase
    .from('user_progress_entries')
    .upsert(payload, { onConflict: 'user_id,entry_date' })
    .select(PROGRESS_COLS)
    .single();
  if (error) throw error;
  return mapProgress(data as SupabaseProgressRow);
}

export async function deleteProgressEntry(id: string): Promise<void> {
  const userId = await getUserId();
  // Scope by user_id as defence-in-depth on top of RLS.
  const { error } = await supabase
    .from('user_progress_entries')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
}

// ─── user_meal_log ──────────────────────────────────────────────────────
// Daily food log: meals + snacks, each row already carries its absolute
// nutrition (portion math is done before insert), so a day's totals are a
// plain SUM. Persistence: rows live in public.user_meal_log (migration
// 20260531000001), scoped to the session user via RLS.

interface SupabaseMealRow {
  id: string;
  entry_date: string;
  meal_category: MealCategory;
  name: string;
  recipe_id: string | null;
  portions: number | string | null;
  calories: number | string | null;
  protein_g: number | string | null;
  carbs_g: number | string | null;
  fat_g: number | string | null;
  satiety: number | null;
  nutrition_estimated: boolean;
  created_at: string;
}

const MEAL_COLS =
  'id, entry_date, meal_category, name, recipe_id, portions, calories, protein_g, carbs_g, fat_g, satiety, nutrition_estimated, created_at';

function num(value: number | string | null): number | undefined {
  return value != null ? Number(value) : undefined;
}

function mapMeal(row: SupabaseMealRow): MealLogEntry {
  return {
    id: row.id,
    date: row.entry_date,
    category: row.meal_category,
    name: row.name,
    recipeId: row.recipe_id ?? undefined,
    portions: num(row.portions),
    calories: num(row.calories),
    protein: num(row.protein_g),
    carbs: num(row.carbs_g),
    fat: num(row.fat_g),
    satiety: row.satiety ?? undefined,
    nutritionEstimated: Boolean(row.nutrition_estimated),
    createdAt: row.created_at,
  };
}

/** All food-log entries for one day, oldest first (matches eating order). */
export async function listMealEntries(date: string): Promise<MealLogEntry[]> {
  const userId = await getUserId();
  const { data, error } = await supabase
    .from('user_meal_log')
    .select(MEAL_COLS)
    .eq('user_id', userId)
    .eq('entry_date', date)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as SupabaseMealRow[]).map(mapMeal);
}

export interface AddMealEntryInput {
  date: string;
  category: MealCategory;
  name: string;
  recipeId?: string;
  portions?: number;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  satiety?: number;
  /** Defaults to true (honest "estimated" unless a verified source says so). */
  nutritionEstimated?: boolean;
}

export async function addMealEntry(input: AddMealEntryInput): Promise<MealLogEntry> {
  const userId = await getUserId();
  const payload = {
    user_id: userId,
    entry_date: input.date,
    meal_category: input.category,
    name: input.name.trim(),
    recipe_id: input.recipeId ?? null,
    portions: input.portions ?? null,
    calories: input.calories ?? null,
    protein_g: input.protein ?? null,
    carbs_g: input.carbs ?? null,
    fat_g: input.fat ?? null,
    satiety: input.satiety ?? null,
    nutrition_estimated: input.nutritionEstimated ?? true,
  };
  const { data, error } = await supabase
    .from('user_meal_log')
    .insert(payload)
    .select(MEAL_COLS)
    .single();
  if (error) throw error;
  return mapMeal(data as SupabaseMealRow);
}

export async function deleteMealEntry(id: string): Promise<void> {
  const userId = await getUserId();
  const { error } = await supabase
    .from('user_meal_log')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
}

export interface LogRecipeMealInput {
  date: string;
  category: MealCategory;
  recipeId: string;
  recipeName: string;
  /** Number of portions eaten. Per-serving nutrition is multiplied by this. */
  portions: number;
  /** Per-serving nutrition from the recipe. Missing fields stay undefined. */
  caloriesPerServing?: number;
  proteinPerServing?: number;
  carbsPerServing?: number;
  fatPerServing?: number;
}

/**
 * Log a planned/viewed recipe as eaten. Multiplies the recipe's per-serving
 * nutrition by the chosen portions and stores absolute values. Recipe nutrition
 * is treated as estimated. This is separate from the cooked-log (cookLogApi):
 * "cooked" stays a distinct signal, "eaten" feeds the tracker.
 */
export async function logRecipeAsMeal(input: LogRecipeMealInput): Promise<MealLogEntry> {
  const p = input.portions > 0 ? input.portions : 1;
  const scale = (value?: number) =>
    value != null && Number.isFinite(value) ? Math.round(value * p * 10) / 10 : undefined;
  return addMealEntry({
    date: input.date,
    category: input.category,
    name: input.recipeName,
    recipeId: input.recipeId,
    portions: p,
    calories: scale(input.caloriesPerServing),
    protein: scale(input.proteinPerServing),
    carbs: scale(input.carbsPerServing),
    fat: scale(input.fatPerServing),
    nutritionEstimated: true,
  });
}

/** Sum a day's logged meals into macro totals (does not include water). */
export function sumMealEntries(entries: MealLogEntry[]): {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
} {
  return entries.reduce(
    (acc, e) => ({
      calories: acc.calories + (e.calories ?? 0),
      protein: acc.protein + (e.protein ?? 0),
      carbs: acc.carbs + (e.carbs ?? 0),
      fat: acc.fat + (e.fat ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

// ─── user_water_log ─────────────────────────────────────────────────────
// One cumulative row per (user, day). The quick buttons bump amount_ml.

/** Today's (or given day's) water total in ml. 0 if no row yet. */
export async function getWaterMl(date: string): Promise<number> {
  const userId = await getUserId();
  const { data, error } = await supabase
    .from('user_water_log')
    .select('amount_ml')
    .eq('user_id', userId)
    .eq('entry_date', date)
    .maybeSingle();
  if (error) throw error;
  return data ? Number((data as { amount_ml: number }).amount_ml) : 0;
}

/**
 * Add (or subtract, with a negative delta) water for a day and return the new
 * total. Clamped at 0. Upserts the (user, day) row.
 */
export async function addWater(date: string, deltaMl: number): Promise<number> {
  const userId = await getUserId();
  const current = await getWaterMl(date);
  const next = Math.max(0, Math.min(20000, current + deltaMl));
  const { error } = await supabase
    .from('user_water_log')
    .upsert(
      { user_id: userId, entry_date: date, amount_ml: next },
      { onConflict: 'user_id,entry_date' },
    );
  if (error) throw error;
  return next;
}
