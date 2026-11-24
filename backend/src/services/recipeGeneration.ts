// AI-driven recipe generation.
//
// Input:  current deals (from Supabase public.deals) + optional meal-type
//         distribution + count.
// Output: N recipes persisted to public.recipes / recipe_ingredients /
//         recipe_instructions.
//
// LLM is Ollama (local) using JSON output mode. The prompt asks the model to
// pick 3-7 deals from the provided list as the recipe's core ingredients, so
// the resulting recipe is naturally "deal-oriented" and shows up with green
// deal badges in the Cheffity swipe deck.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'sweet_baked', 'drinks'] as const;
const VALID_CATEGORIES = [
  'fruits_vegetables', 'meat_fish', 'dairy', 'drinks',
  'snacks_sweets', 'frozen', 'other',
] as const;
const VALID_DIFFICULTIES = ['easy', 'medium', 'advanced'] as const;
const VALID_ALLERGENS = [
  'gluten', 'lactose', 'nuts', 'eggs', 'soy', 'fish', 'seafood', 'sesame',
] as const;

type MealType = (typeof VALID_MEAL_TYPES)[number];
type Category = (typeof VALID_CATEGORIES)[number];
type Difficulty = (typeof VALID_DIFFICULTIES)[number];
type Allergen = (typeof VALID_ALLERGENS)[number];

interface DealHint {
  id: string;
  name: string;
  store: string;
  price: number;
  category: Category;
}

interface ParsedIngredient {
  name: string;
  amount: number;
  unit: string;
  matchedDealId?: string;
  allergens: Allergen[];
  is_halal: boolean;
  contains_alcohol: boolean;
}

interface ParsedRecipe {
  name: string;
  intro: string;
  meal_type: MealType;
  category: Category;
  difficulty: Difficulty;
  cook_time_minutes: number;
  default_portions: number;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  ingredients: ParsedIngredient[];
  instructions: string[];
}

export interface GenerationResult {
  attempted: number;
  generated: number;
  failed: number;
  generatedIds: string[];
  errors: string[];
  durationMs: number;
}

const OLLAMA_HOST = process.env.VITE_OLLAMA_HOST ?? 'http://localhost:11434';
// Default updated 2026-05-18 — kept in sync with backend/src/server.ts.
const OLLAMA_MODEL = process.env.VITE_OLLAMA_MODEL ?? 'qwen3:14b';

let cachedClient: SupabaseClient | null = null;
function getClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cachedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

async function fetchActiveDeals(client: SupabaseClient, limit = 80): Promise<DealHint[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await client
    .from('deals')
    .select('id, name, store_name, current_price, category, valid_to, is_food')
    .gte('valid_to', today)
    .or('is_food.is.null,is_food.eq.true')
    .limit(limit * 2);  // overfetch then dedupe
  if (error) throw error;

  const seen = new Set<string>();
  const hints: DealHint[] = [];
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const name = String(r.name ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    hints.push({
      id: String(r.id),
      name,
      store: String(r.store_name ?? ''),
      price: Number(r.current_price ?? 0),
      category: (r.category as Category) ?? 'other',
    });
    if (hints.length >= limit) break;
  }
  return hints;
}

function buildSystemPrompt(): string {
  return `Du bist ein deutscher Rezept-Generator für die Cheffity-App. Du erzeugst alltagstaugliche, einfache deutsche Rezepte.

Erzeuge EIN Rezept als striktes JSON-Objekt nach dem unten genannten Schema. Antworte NUR mit dem JSON-Objekt, keine Erklärung davor oder danach, kein Markdown-Codeblock.

Schema:
{
  "name": "Gerichtname auf Deutsch, max 50 Zeichen",
  "intro": "1-2 Sätze Einleitung auf Deutsch, max 200 Zeichen",
  "meal_type": "breakfast | lunch | dinner | sweet_baked | drinks",
  "category": "fruits_vegetables | meat_fish | dairy | drinks | snacks_sweets | frozen | other",
  "difficulty": "easy | medium | advanced",
  "cook_time_minutes": 15-90,
  "default_portions": 2-4,
  "calories": geschätzte kcal pro Portion (Zahl),
  "protein_g": geschätzte g (Zahl),
  "carbs_g": geschätzte g (Zahl),
  "fat_g": geschätzte g (Zahl),
  "ingredients": [
    {
      "name": "Zutatname auf Deutsch",
      "amount": Menge als Zahl,
      "unit": "g | ml | Stk | EL | TL | Prise",
      "matchedDealId": "optional: die ID aus der unten genannten Angebote-Liste falls diese Zutat ein Angebot ist",
      "allergens": ["gluten" | "lactose" | "nuts" | "eggs" | "soy" | "fish" | "seafood" | "sesame"] (nur diese Werte),
      "is_halal": true wenn halal-konform,
      "contains_alcohol": true wenn Alkohol enthält
    }
  ],
  "instructions": [
    "Schritt 1: ...",
    "Schritt 2: ..."
  ]
}

Regeln:
- 4-10 Zutaten
- 3-7 Zubereitungsschritte
- Nutze 2-5 Angebote aus der untenstehenden Liste als Hauptzutaten (matchedDealId angeben)
- Schritte sind klar, kurz, ohne Markdown
- Allergene streng aus dem erlaubten Satz, nicht erfinden
- Wenn alles vegan/vegetarisch: is_halal=true, contains_alcohol=false`;
}

function buildUserPrompt(deals: DealHint[], mealTypeHint?: MealType): string {
  const dealLines = deals
    .map((d, i) => `${i + 1}. ${d.name} (${d.store}, ${d.price.toFixed(2)}€) [id: ${d.id}, kat: ${d.category}]`)
    .join('\n');

  const mealTypeLine = mealTypeHint
    ? `\nGewünschte Mahlzeit: ${mealTypeHint}\n`
    : '\nMahlzeit frei wählbar (breakfast/lunch/dinner/sweet_baked/drinks).\n';

  return `Aktuelle Wochen-Angebote in deutschen Supermärkten:

${dealLines}
${mealTypeLine}
Erzeuge EIN Rezept das 2-5 dieser Angebote nutzt. Gib NUR das JSON-Objekt zurück.`;
}

async function callOllama(systemPrompt: string, userPrompt: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        format: 'json',  // Ollama JSON mode
        options: { temperature: 0.7 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}`);
    }
    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  } finally {
    clearTimeout(timeoutId);
  }
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = String(value ?? '').toLowerCase().trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function pickAllergens(value: unknown): Allergen[] {
  if (!Array.isArray(value)) return [];
  const out: Allergen[] = [];
  for (const entry of value) {
    const v = String(entry ?? '').toLowerCase().trim();
    if ((VALID_ALLERGENS as readonly string[]).includes(v)) out.push(v as Allergen);
  }
  return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function optionalNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function validateRecipe(raw: unknown): ParsedRecipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const name = String(r.name ?? '').trim();
  if (!name) return null;

  const intro = String(r.intro ?? '').trim();
  const mealType = pickEnum(r.meal_type, VALID_MEAL_TYPES, 'lunch');
  const category = pickEnum(r.category, VALID_CATEGORIES, 'other');
  const difficulty = pickEnum(r.difficulty, VALID_DIFFICULTIES, 'medium');
  const cookTime = clampInt(r.cook_time_minutes, 5, 240, 30);
  const portions = clampInt(r.default_portions, 1, 12, 2);

  const rawIngredients = Array.isArray(r.ingredients) ? r.ingredients : [];
  const ingredients: ParsedIngredient[] = [];
  for (const item of rawIngredients) {
    if (!item || typeof item !== 'object') continue;
    const ing = item as Record<string, unknown>;
    const ingName = String(ing.name ?? '').trim();
    if (!ingName) continue;
    const amount = Number(ing.amount);
    ingredients.push({
      name: ingName,
      amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
      unit: String(ing.unit ?? '').trim() || 'g',
      matchedDealId: typeof ing.matchedDealId === 'string' && ing.matchedDealId.length > 0
        ? ing.matchedDealId
        : undefined,
      allergens: pickAllergens(ing.allergens),
      is_halal: ing.is_halal !== false,
      contains_alcohol: ing.contains_alcohol === true,
    });
  }
  if (ingredients.length < 2) return null;

  const rawInstructions = Array.isArray(r.instructions) ? r.instructions : [];
  const instructions = rawInstructions
    .map((step) => String(step ?? '').trim())
    .filter((step) => step.length > 0);
  if (instructions.length < 2) return null;

  return {
    name: name.slice(0, 80),
    intro: intro.slice(0, 400),
    meal_type: mealType,
    category,
    difficulty,
    cook_time_minutes: cookTime,
    default_portions: portions,
    calories: optionalNumber(r.calories),
    protein_g: optionalNumber(r.protein_g),
    carbs_g: optionalNumber(r.carbs_g),
    fat_g: optionalNumber(r.fat_g),
    ingredients,
    instructions,
  };
}

async function persistRecipe(
  client: SupabaseClient,
  recipe: ParsedRecipe,
  validDealIds: Set<string>,
): Promise<string> {
  const { data: insertedRecipe, error: insertError } = await client
    .from('recipes')
    .insert({
      name: { de: recipe.name },
      intro: recipe.intro ? { de: recipe.intro } : null,
      meal_type: recipe.meal_type,
      category: recipe.category,
      difficulty: recipe.difficulty,
      cook_time_minutes: recipe.cook_time_minutes,
      default_portions: recipe.default_portions,
      calories: recipe.calories,
      protein_g: recipe.protein_g,
      carbs_g: recipe.carbs_g,
      fat_g: recipe.fat_g,
      status: 'active',
      source: 'ai_generated',
    })
    .select('id')
    .single();
  if (insertError || !insertedRecipe) {
    throw new Error(`recipes insert failed: ${insertError?.message ?? 'unknown'}`);
  }
  const recipeId = (insertedRecipe as { id: string }).id;

  if (recipe.ingredients.length > 0) {
    const ingRows = recipe.ingredients.map((ing, i) => ({
      recipe_id: recipeId,
      position: i,
      name: { de: ing.name },
      amount: ing.amount,
      unit: ing.unit,
      is_potential_deal: !!ing.matchedDealId,
      allergens: ing.allergens,
      is_halal: ing.is_halal,
      contains_alcohol: ing.contains_alcohol,
    }));
    const { data: insertedIngredients, error } = await client
      .from('recipe_ingredients')
      .insert(ingRows)
      .select('id, position');
    if (error) throw new Error(`ingredients insert failed: ${error.message}`);

    // Persist deal_recipe_matches for ingredients the LLM tied to a real,
    // currently-known deal. Only IDs from the deals list we sent the model
    // are written, so a hallucinated id can't trip the FK. Non-fatal: the
    // recipe + is_potential_deal flag already exist if this step fails.
    const idByPosition = new Map<number, string>();
    for (const r of (insertedIngredients ?? []) as { id: string; position: number }[]) {
      idByPosition.set(r.position, r.id);
    }
    const matchRows: { deal_id: string; recipe_ingredient_id: string }[] = [];
    recipe.ingredients.forEach((ing, i) => {
      const ingredientId = idByPosition.get(i);
      if (ing.matchedDealId && ingredientId && validDealIds.has(ing.matchedDealId)) {
        matchRows.push({ deal_id: ing.matchedDealId, recipe_ingredient_id: ingredientId });
      }
    });
    if (matchRows.length > 0) {
      const { error: matchError } = await client
        .from('deal_recipe_matches')
        .insert(matchRows);
      if (matchError) {
        console.warn(
          `deal_recipe_matches insert failed for recipe ${recipeId}: ${matchError.message}`,
        );
      }
    }
  }

  if (recipe.instructions.length > 0) {
    const insRows = recipe.instructions.map((text, i) => ({
      recipe_id: recipeId,
      step_number: i + 1,
      text: { de: text },
    }));
    const { error } = await client.from('recipe_instructions').insert(insRows);
    if (error) throw new Error(`instructions insert failed: ${error.message}`);
  }

  return recipeId;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Sometimes the model wraps output in code fences despite the system prompt
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

export function isRecipeGenerationConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function generateRecipes(count: number): Promise<GenerationResult> {
  const startedAt = Date.now();
  const result: GenerationResult = {
    attempted: count,
    generated: 0,
    failed: 0,
    generatedIds: [],
    errors: [],
    durationMs: 0,
  };

  const client = getClient();
  if (!client) {
    result.errors.push('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.');
    result.failed = count;
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  let deals: DealHint[];
  try {
    deals = await fetchActiveDeals(client);
  } catch (e) {
    result.errors.push(`fetch deals: ${(e as Error).message}`);
    result.failed = count;
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  if (deals.length === 0) {
    result.errors.push('No active deals in Supabase. Run /api/offers/sync-supabase first.');
    result.failed = count;
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // IDs we actually sent the model — the only ones safe to write into
  // deal_recipe_matches (anything else would be a hallucinated/stale id).
  const validDealIds = new Set(deals.map((d) => d.id));

  // Vary the meal-type bias across the batch so we don't get 10 lunches.
  const mealRotation: MealType[] = ['lunch', 'dinner', 'breakfast', 'lunch', 'dinner'];

  const systemPrompt = buildSystemPrompt();

  for (let i = 0; i < count; i++) {
    // Shuffle deals subset per recipe for variety
    const shuffled = [...deals].sort(() => Math.random() - 0.5).slice(0, 25);
    const mealType = mealRotation[i % mealRotation.length];
    const userPrompt = buildUserPrompt(shuffled, mealType);

    try {
      const raw = await callOllama(systemPrompt, userPrompt);
      const parsed = validateRecipe(safeJsonParse(raw));
      if (!parsed) {
        result.failed += 1;
        result.errors.push(`recipe ${i + 1}: invalid LLM output (${raw.slice(0, 80)}...)`);
        continue;
      }
      const id = await persistRecipe(client, parsed, validDealIds);
      result.generated += 1;
      result.generatedIds.push(id);
    } catch (e) {
      result.failed += 1;
      result.errors.push(`recipe ${i + 1}: ${(e as Error).message}`);
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
