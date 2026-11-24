import { supabase } from '../config/supabase';

export interface LogCookedInput {
  recipeId: string;
  weeklyPlanEntryId?: string;
  rating?: number;
  notes?: string;
}

export async function logCookedRecipe(input: LogCookedInput): Promise<void> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Nicht angemeldet');

  const { error } = await supabase.from('recipe_cooked_log').insert({
    user_id: user.id,
    recipe_id: input.recipeId,
    weekly_plan_entry_id: input.weeklyPlanEntryId ?? null,
    rating: input.rating ?? null,
    notes: input.notes ?? null,
  });
  if (error) throw error;
}

export async function fetchCookedCountForRecipe(recipeId: string): Promise<number> {
  const { count, error } = await supabase
    .from('recipe_cooked_log')
    .select('id', { count: 'exact', head: true })
    .eq('recipe_id', recipeId);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Which of the given weekly_plan_entry ids already have a cooked-log row.
 * Used by the planner to render the "Gekocht"-badge per planned entry.
 */
export async function fetchCookedEntryIds(
  weeklyPlanEntryIds: string[],
): Promise<Set<string>> {
  const result = new Set<string>();
  if (weeklyPlanEntryIds.length === 0) return result;
  const { data, error } = await supabase
    .from('recipe_cooked_log')
    .select('weekly_plan_entry_id')
    .in('weekly_plan_entry_id', weeklyPlanEntryIds);
  if (error) throw error;
  for (const row of (data ?? []) as { weekly_plan_entry_id: string | null }[]) {
    if (row.weekly_plan_entry_id) result.add(row.weekly_plan_entry_id);
  }
  return result;
}

/**
 * Mark a planned entry as cooked. Idempotent: `recipe_cooked_log` has no
 * unique constraint on `weekly_plan_entry_id`, so we check first and skip if a
 * row already exists — no duplicate cooked-log entries.
 */
export async function markEntryCooked(input: {
  recipeId: string;
  weeklyPlanEntryId: string;
}): Promise<void> {
  const { count, error } = await supabase
    .from('recipe_cooked_log')
    .select('id', { count: 'exact', head: true })
    .eq('weekly_plan_entry_id', input.weeklyPlanEntryId);
  if (error) throw error;
  if ((count ?? 0) > 0) return; // already cooked → do not double-write
  await logCookedRecipe({
    recipeId: input.recipeId,
    weeklyPlanEntryId: input.weeklyPlanEntryId,
  });
}

/**
 * Mark a planned entry as NOT cooked again by deleting its cooked-log row(s).
 * "Not cooked" is modelled as the absence of a cooked-log row — fully
 * persistent with the existing table, no extra schema. A distinct "skipped"
 * state (different from "not yet cooked") is intentionally NOT persisted.
 */
export async function unmarkEntryCooked(weeklyPlanEntryId: string): Promise<void> {
  const { error } = await supabase
    .from('recipe_cooked_log')
    .delete()
    .eq('weekly_plan_entry_id', weeklyPlanEntryId);
  if (error) throw error;
}
