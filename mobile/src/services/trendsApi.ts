import { supabase } from '../config/supabase';

export interface RecipeTrendRow {
  recipeId: string;
  name: string;
  imageUrl: string | null;
  mealType: string;
  category: string;
  difficulty: string;
  cookTimeMinutes: number;
  rating: number | null;
  ratingCount: number;
  cookedCountTotal: number;
  plannedCount30d: number;
  swipePlanCount30d: number;
  cookedCount30d: number;
  uniquePlanners30d: number;
}

export interface ProductTrendRow {
  nameKey: string;
  sampleName: string;
  addedCount: number;
  purchasedCount: number;
  uniqueUsers: number;
}

interface SupabaseRecipeTrend {
  recipe_id: string;
  name_de: string | null;
  image_url: string | null;
  meal_type: string;
  category: string;
  difficulty: string;
  cook_time_minutes: number;
  rating: number | string | null;
  rating_count: number;
  cooked_count: number;
  planned_count_30d: number;
  swipe_plan_count_30d: number;
  cooked_count_30d: number;
  unique_planners_30d: number;
}

interface SupabaseProductTrend {
  name_key: string;
  sample_name: string | null;
  added_count: number;
  purchased_count: number;
  unique_users: number;
}

export async function fetchRecipeTrends(limit = 15): Promise<RecipeTrendRow[]> {
  const { data, error } = await supabase
    .from('recipe_trend_30d')
    .select('*')
    .order('planned_count_30d', { ascending: false })
    .order('cooked_count_30d', { ascending: false })
    .order('rating', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as SupabaseRecipeTrend[]).map((row) => ({
    recipeId: row.recipe_id,
    name: row.name_de ?? '(ohne Name)',
    imageUrl: row.image_url,
    mealType: row.meal_type,
    category: row.category,
    difficulty: row.difficulty,
    cookTimeMinutes: row.cook_time_minutes,
    rating: row.rating != null ? Number(row.rating) : null,
    ratingCount: row.rating_count,
    cookedCountTotal: row.cooked_count,
    plannedCount30d: row.planned_count_30d,
    swipePlanCount30d: row.swipe_plan_count_30d,
    cookedCount30d: row.cooked_count_30d,
    uniquePlanners30d: row.unique_planners_30d,
  }));
}

export async function fetchProductTrends(limit = 30): Promise<ProductTrendRow[]> {
  const { data, error } = await supabase
    .from('product_trend_30d')
    .select('*')
    .order('added_count', { ascending: false })
    .order('purchased_count', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as SupabaseProductTrend[]).map((row) => ({
    nameKey: row.name_key,
    sampleName: row.sample_name ?? row.name_key,
    addedCount: row.added_count,
    purchasedCount: row.purchased_count,
    uniqueUsers: row.unique_users,
  }));
}
