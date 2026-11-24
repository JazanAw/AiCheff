import { supabase } from '../config/supabase';
import type { MealType, WeeklyPlanEntry } from '../types';
import { fetchRecipes } from './recipesApi';

const PLANNER_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner'];

interface PlannerRow {
  id: string;
  week_start_date: string;
  day_of_week: number;
  meal_type: MealType;
  recipe_id: string;
  portion_override: number | null;
}

/**
 * ISO date (YYYY-MM-DD) of Monday of the week containing `date`.
 * Mirrors weekly_plan_entries.week_start_date format.
 */
export function weekStartDate(date: Date = new Date()): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // JS: Sunday=0..Saturday=6. We want Monday=0..Sunday=6.
  const jsDow = d.getDay();
  const isoDow = (jsDow + 6) % 7; // 0=Mon..6=Sun
  d.setDate(d.getDate() - isoDow);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Day-of-week index 0=Mon..6=Sun for today (or given date).
 */
export function todayDayOfWeek(date: Date = new Date()): number {
  return (date.getDay() + 6) % 7;
}

async function getUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Nicht angemeldet');
  return user.id;
}

export async function fetchPlannerEntries(
  weekStart: string = weekStartDate(),
): Promise<WeeklyPlanEntry[]> {
  const userId = await getUserId();
  const { data, error } = await supabase
    .from('weekly_plan_entries')
    .select('id, week_start_date, day_of_week, meal_type, recipe_id, portion_override')
    .eq('user_id', userId)
    .eq('week_start_date', weekStart);
  if (error) throw error;

  const rows = (data ?? []) as PlannerRow[];
  if (rows.length === 0) return [];

  const recipeIds = Array.from(new Set(rows.map((r) => r.recipe_id)));
  // fetchRecipes does not support id-filter directly, so we fetch a generous page
  // and filter. Planner entries are <= 21 per week, so this is cheap.
  const allRecipes = await fetchRecipes({ limit: 200 });
  const byId = new Map(allRecipes.map((r) => [r.id, r]));

  const entries: WeeklyPlanEntry[] = [];
  for (const row of rows) {
    const recipe = byId.get(row.recipe_id);
    if (!recipe) continue;
    if (!recipeIds.includes(row.recipe_id)) continue;
    entries.push({
      id: row.id,
      dayOfWeek: row.day_of_week,
      mealType: row.meal_type,
      recipeId: row.recipe_id,
      recipe,
      portionOverride: row.portion_override ?? undefined,
    });
  }
  return entries;
}

export interface UpsertPlannerInput {
  dayOfWeek: number;
  mealType: MealType;
  recipeId: string;
  portionOverride?: number;
  weekStart?: string;
}

export async function upsertPlannerEntry(input: UpsertPlannerInput): Promise<string> {
  const userId = await getUserId();
  const weekStart = input.weekStart ?? weekStartDate();
  const { data, error } = await supabase
    .from('weekly_plan_entries')
    .upsert(
      {
        user_id: userId,
        week_start_date: weekStart,
        day_of_week: input.dayOfWeek,
        meal_type: input.mealType,
        recipe_id: input.recipeId,
        portion_override: input.portionOverride ?? null,
      },
      { onConflict: 'user_id,week_start_date,day_of_week,meal_type' },
    )
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function removePlannerEntry(id: string): Promise<void> {
  const { error } = await supabase.from('weekly_plan_entries').delete().eq('id', id);
  if (error) throw error;
}

export interface FreeSlot {
  dayOfWeek: number;
  mealType: MealType;
}

/**
 * Find the first free planner slot for the given recipe's meal_type, starting
 * from today and walking forward through the week, then the next week.
 *
 * Returns null if no free slot is found in the next 14 days.
 *
 * - For meal_types not in PLANNER_MEAL_TYPES (sweet_baked, drinks), we map to
 *   'dinner' so the user still sees the recipe in their plan.
 */
export async function findNextFreeSlot(
  recipeMealType: MealType,
  startDate: Date = new Date(),
): Promise<{ slot: FreeSlot; weekStart: string } | null> {
  const userId = await getUserId();
  const targetMealType: MealType = PLANNER_MEAL_TYPES.includes(recipeMealType)
    ? recipeMealType
    : 'dinner';

  const week1Start = weekStartDate(startDate);
  const week2 = new Date(startDate);
  week2.setDate(week2.getDate() + 7);
  const week2Start = weekStartDate(week2);

  const { data, error } = await supabase
    .from('weekly_plan_entries')
    .select('week_start_date, day_of_week, meal_type')
    .eq('user_id', userId)
    .in('week_start_date', [week1Start, week2Start])
    .eq('meal_type', targetMealType);
  if (error) throw error;

  const taken = new Set<string>();
  for (const row of (data ?? []) as Pick<PlannerRow, 'week_start_date' | 'day_of_week' | 'meal_type'>[]) {
    taken.add(`${row.week_start_date}|${row.day_of_week}|${row.meal_type}`);
  }

  const startDow = todayDayOfWeek(startDate);
  for (let dow = startDow; dow < 7; dow++) {
    const key = `${week1Start}|${dow}|${targetMealType}`;
    if (!taken.has(key)) {
      return { slot: { dayOfWeek: dow, mealType: targetMealType }, weekStart: week1Start };
    }
  }
  for (let dow = 0; dow < 7; dow++) {
    const key = `${week2Start}|${dow}|${targetMealType}`;
    if (!taken.has(key)) {
      return { slot: { dayOfWeek: dow, mealType: targetMealType }, weekStart: week2Start };
    }
  }
  return null;
}
