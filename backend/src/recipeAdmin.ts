// Recipe management data layer for /admin-v2.
//
// Read-only overview of every Cheffity recipe + a narrow status/review toggle.
// No delete, no full edit. Uses the Service-Role key (SUPABASE_*); degrades to
// `available:false` with a clear message when Supabase isn't configured.
//
// `select('*')` is used on purpose so the overview works both before AND after
// the local metadata migration (20260529000001) is pushed — columns that don't
// exist yet simply come back undefined and the summary treats them as "missing".

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const RECIPE_ADMIN_STATUSES = ['active', 'hidden'] as const;
export type RecipeAdminStatus = (typeof RECIPE_ADMIN_STATUSES)[number];

export const RECIPE_VERIFICATION_STATUSES = [
  'draft',
  'reviewed',
  'published',
] as const;
export type RecipeVerificationStatus =
  (typeof RECIPE_VERIFICATION_STATUSES)[number];

const AI_SOURCE_TYPES = new Set(['ai_generated', 'ai_adapted']);

/** Loose shape of a `public.recipes` row as returned by `select('*')`. */
export interface RawRecipeRow {
  id: string;
  name?: unknown;
  status?: string | null;
  source_type?: string | null;
  verification_status?: string | null;
  ai_notice_required?: boolean | null;
  safety_notes?: string | null;
  meal_type?: string | null;
  difficulty?: string | null;
  cook_time_minutes?: number | null;
  prep_time_minutes?: number | null;
  cuisine?: string | null;
  tags?: unknown;
  diet_flags?: unknown;
  halal_status?: string | null;
  halal_notes?: string | null;
  calories?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  image_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AdminRecipeSummary {
  id: string;
  title: string;
  status: string;
  sourceType: string | null;
  verificationStatus: string | null;
  aiNoticeRequired: boolean;
  mealType: string | null;
  difficulty: string | null;
  cookTimeMinutes: number | null;
  prepTimeMinutes: number | null;
  cuisine: string | null;
  tags: string[];
  dietFlags: string[];
  halalStatus: string | null;
  halalNotes: string | null;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  hasImage: boolean;
  ingredientsCount: number;
  instructionsCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  // ── Warning flags (drive the admin filters + badges) ──────────────────────
  isAi: boolean;
  missingImage: boolean;
  missingNutrition: boolean;
  /** Only meaningful for AI recipes — a visible AI recipe must carry a notice. */
  missingSafetyNotes: boolean;
  halalUnclear: boolean;
  needsReview: boolean;
}

export interface AdminRecipesPayload {
  available: boolean;
  generatedAt: string;
  total: number;
  recipes: AdminRecipeSummary[];
  error?: string;
}

export interface AdminRecipeUpdateResult {
  ok: boolean;
  id?: string;
  status?: string;
  verificationStatus?: string;
  error?: string;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function pickName(name: unknown): string {
  if (name && typeof name === 'object') {
    const obj = name as Record<string, unknown>;
    for (const key of ['de', 'en', 'tr', 'it', 'es', 'pl']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    const first = Object.values(obj).find(
      (v) => typeof v === 'string' && v.trim().length > 0,
    );
    if (typeof first === 'string') return first.trim();
  }
  if (typeof name === 'string' && name.trim().length > 0) return name.trim();
  return '(ohne Name)';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function toNumberOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build the admin summary + warning flags for one recipe row. Pure — testable
 * without Supabase. `counts` come from a single grouped lookup over the child
 * tables (see `getAdminRecipes`).
 */
export function summarizeRecipeRow(
  row: RawRecipeRow,
  counts: { ingredients: number; instructions: number },
): AdminRecipeSummary {
  const sourceType = row.source_type ?? null;
  const isAi = sourceType != null && AI_SOURCE_TYPES.has(sourceType);
  const verificationStatus = row.verification_status ?? null;
  const aiNoticeRequired = row.ai_notice_required === true;

  const calories = toNumberOrNull(row.calories);
  const proteinG = toNumberOrNull(row.protein_g);
  const carbsG = toNumberOrNull(row.carbs_g);
  const fatG = toNumberOrNull(row.fat_g);
  const missingNutrition =
    calories == null && proteinG == null && carbsG == null && fatG == null;

  const hasImage = nonEmpty(row.image_url);
  const halalStatus = row.halal_status ?? null;
  const halalUnclear = halalStatus == null || halalStatus === 'unclear';
  const missingSafetyNotes = isAi && !nonEmpty(row.safety_notes);

  const needsReview =
    verificationStatus === 'draft' ||
    (isAi && !aiNoticeRequired) ||
    missingSafetyNotes;

  return {
    id: row.id,
    title: pickName(row.name),
    status: row.status ?? 'active',
    sourceType,
    verificationStatus,
    aiNoticeRequired,
    mealType: row.meal_type ?? null,
    difficulty: row.difficulty ?? null,
    cookTimeMinutes: toNumberOrNull(row.cook_time_minutes),
    prepTimeMinutes: toNumberOrNull(row.prep_time_minutes),
    cuisine: nonEmpty(row.cuisine) ? (row.cuisine as string).trim() : null,
    tags: toStringArray(row.tags),
    dietFlags: toStringArray(row.diet_flags),
    halalStatus,
    halalNotes: nonEmpty(row.halal_notes) ? (row.halal_notes as string).trim() : null,
    calories,
    proteinG,
    carbsG,
    fatG,
    hasImage,
    ingredientsCount: counts.ingredients,
    instructionsCount: counts.instructions,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    isAi,
    missingImage: !hasImage,
    missingNutrition,
    missingSafetyNotes,
    halalUnclear,
    needsReview,
  };
}

/** Tally `recipe_id` occurrences from a child table's rows. */
export function tallyByRecipeId(
  rows: Array<{ recipe_id?: string | null }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const id = r.recipe_id;
    if (typeof id === 'string') map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
}

// ── Supabase IO ───────────────────────────────────────────────────────────

let cachedClient: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    cachedClient = null;
    return null;
  }
  cachedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

export function isRecipeAdminConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const NOT_CONFIGURED = 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt.';

export async function getAdminRecipes(): Promise<AdminRecipesPayload> {
  const generatedAt = new Date().toISOString();
  const client = getClient();
  if (!client) {
    return { available: false, generatedAt, total: 0, recipes: [], error: NOT_CONFIGURED };
  }
  try {
    const { data: recipeRows, error } = await client
      .from('recipes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) throw new Error(error.message);

    const rows = (recipeRows ?? []) as RawRecipeRow[];

    const [ingRes, insRes] = await Promise.all([
      client.from('recipe_ingredients').select('recipe_id').limit(50000),
      client.from('recipe_instructions').select('recipe_id').limit(50000),
    ]);
    const ingCounts = tallyByRecipeId(
      (ingRes.data ?? []) as Array<{ recipe_id?: string | null }>,
    );
    const insCounts = tallyByRecipeId(
      (insRes.data ?? []) as Array<{ recipe_id?: string | null }>,
    );

    const recipes = rows.map((row) =>
      summarizeRecipeRow(row, {
        ingredients: ingCounts.get(row.id) ?? 0,
        instructions: insCounts.get(row.id) ?? 0,
      }),
    );

    return { available: true, generatedAt, total: recipes.length, recipes };
  } catch (err) {
    return {
      available: false,
      generatedAt,
      total: 0,
      recipes: [],
      error: err instanceof Error ? err.message : 'Unbekannter Fehler',
    };
  }
}

export async function updateRecipeStatus(
  id: string,
  status: string,
): Promise<AdminRecipeUpdateResult> {
  if (!id) return { ok: false, error: 'id fehlt' };
  if (!RECIPE_ADMIN_STATUSES.includes(status as RecipeAdminStatus)) {
    return { ok: false, error: `status muss ${RECIPE_ADMIN_STATUSES.join(' | ')} sein` };
  }
  const client = getClient();
  if (!client) return { ok: false, error: NOT_CONFIGURED };
  try {
    const { data, error } = await client
      .from('recipes')
      .update({ status })
      .eq('id', id)
      .select('id, status')
      .single();
    if (error) throw new Error(error.message);
    if (!data) return { ok: false, error: 'Rezept nicht gefunden' };
    const updated = data as { id: string; status: string };
    return { ok: true, id: updated.id, status: updated.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unbekannter Fehler' };
  }
}

export async function updateRecipeReview(
  id: string,
  verificationStatus: string,
): Promise<AdminRecipeUpdateResult> {
  if (!id) return { ok: false, error: 'id fehlt' };
  if (
    !RECIPE_VERIFICATION_STATUSES.includes(
      verificationStatus as RecipeVerificationStatus,
    )
  ) {
    return {
      ok: false,
      error: `verification_status muss ${RECIPE_VERIFICATION_STATUSES.join(' | ')} sein`,
    };
  }
  const client = getClient();
  if (!client) return { ok: false, error: NOT_CONFIGURED };
  try {
    const { data, error } = await client
      .from('recipes')
      .update({ verification_status: verificationStatus })
      .eq('id', id)
      .select('id, verification_status')
      .single();
    if (error) throw new Error(error.message);
    if (!data) return { ok: false, error: 'Rezept nicht gefunden' };
    const updated = data as { id: string; verification_status: string };
    return { ok: true, id: updated.id, verificationStatus: updated.verification_status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unbekannter Fehler' };
  }
}
