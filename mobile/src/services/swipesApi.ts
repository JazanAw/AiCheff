import { supabase } from '../config/supabase';
import type { MealType, SwipeAction } from '../types';

interface RecordSwipeOptions {
  mealType?: MealType;
  weekStartDate?: string;
}

export async function recordSwipe(
  recipeId: string,
  action: SwipeAction,
  options: RecordSwipeOptions = {},
): Promise<void> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Nicht angemeldet');

  const { error } = await supabase.from('recipe_swipes').insert({
    user_id: user.id,
    recipe_id: recipeId,
    action,
    meal_type: options.mealType ?? null,
    week_start_date: options.weekStartDate ?? null,
  });
  if (error) throw error;
}

export interface UserRecipeState {
  bannedIds: Set<string>;
  favoriteIds: Set<string>;
  plannedIds: Set<string>;
}

interface UserRecipeStateRow {
  recipe_id: string;
  action: SwipeAction;
}

export async function fetchUserRecipeState(): Promise<UserRecipeState> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Nicht angemeldet');

  const { data, error } = await supabase
    .from('user_recipe_state')
    .select('recipe_id, action')
    .eq('user_id', user.id);
  if (error) throw error;

  const bannedIds = new Set<string>();
  const favoriteIds = new Set<string>();
  const plannedIds = new Set<string>();
  for (const row of (data ?? []) as UserRecipeStateRow[]) {
    if (row.action === 'never') bannedIds.add(row.recipe_id);
    else if (row.action === 'favorite') favoriteIds.add(row.recipe_id);
    else if (row.action === 'add_to_plan') plannedIds.add(row.recipe_id);
  }
  return { bannedIds, favoriteIds, plannedIds };
}
