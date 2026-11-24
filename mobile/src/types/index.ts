export type SubscriptionTier = 'free' | 'plus' | 'premium';

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'sweet_baked' | 'drinks';

export type SwipeAction = 'not_now' | 'add_to_plan' | 'never' | 'favorite' | 'unfavorite';

export type Difficulty = 'easy' | 'medium' | 'advanced';

export type DealCategory =
  | 'fruits_vegetables'
  | 'meat_fish'
  | 'dairy'
  | 'bakery'
  | 'drinks'
  | 'snacks_sweets'
  | 'pantry'
  | 'ready_meals'
  | 'frozen'
  | 'other';

export type Allergy =
  | 'gluten'
  | 'lactose'
  | 'nuts'
  | 'eggs'
  | 'soy'
  | 'fish'
  | 'seafood'
  | 'sesame';

// Auto-detected product-info statuses. "unknown" is a first-class value so the
// UI can show an honest "unklar"/"offen" chip instead of implying a fact.
export type NutritionStatus = 'verified' | 'estimated' | 'unknown';
export type HalalStatus = 'halal' | 'not_halal' | 'doubtful' | 'unknown';
export type AllergenStatus = 'known' | 'risk' | 'unknown';

export type ActivityLevel =
  | 'barely_active'
  | 'lightly_active'
  | 'moderately_active'
  | 'very_active';

export type Gender = 'male' | 'female';

export type Language = 'de' | 'en' | 'tr' | 'it' | 'es' | 'pl';

export interface UserProfile {
  id: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  subscriptionTier: SubscriptionTier;
  language: Language;
  onboardingCompleted: boolean;
  createdAt: string;
}

export interface UserPreferences {
  searchRadiusKm: number;
  allergies: Allergy[];
  halalFilter: boolean;
  hideAlcohol: boolean;
  excludedFoods: string[];
  defaultPortionSize: number;
  latitude?: number;
  longitude?: number;
}

export interface Deal {
  id: string;
  /** Produktfamilien-Id (article_v3). `id` identifiziert EIN Händler-Angebot und
   *  wechselt bei Lidl/ALDI NORD wöchentlich; `articleId` bleibt gleich und ist
   *  deshalb der Anker, den Favoriten speichern. */
  articleId?: string;
  name: string;
  storeId?: string;
  storeName: string;
  storeCity?: string;
  storeAddress?: string;
  storeLogoUrl?: string;
  category: DealCategory;
  currentPrice: number;
  originalPrice?: number;
  savingsPercent?: number;
  imageUrl?: string;
  validFrom: string;
  validTo: string;
  isNational: boolean;
  distanceKm?: number;
  nutrition?: NutritionInfo;
  ingredients?: string[];
  isHalal?: boolean;
  /** Whether the offer contains alcohol. Null/undefined = unknown (no pill). */
  containsAlcohol?: boolean;
  /** Explicit-only diet flags. undefined = source never said (no pill). */
  isVegan?: boolean;
  isVegetarian?: boolean;
  allergens?: Allergy[];
  /** Auto-detected status summaries for the "Produktinfos" section. Always set
   *  by offersApi (defaults to the honest "unknown"). */
  nutritionStatus?: NutritionStatus;
  halalStatus?: HalalStatus;
  allergenStatus?: AllergenStatus;
  /** Curation hint used to slot a deal into the "Top Angebote" / "Trend-Angebote"
   *  sections of the deals screen. Derived in offersApi (discount + trend score). */
  highlight?: 'top' | 'trend' | null;
  /** Anonymous, aggregated popularity score (0-100). Drives the trend section. */
  trendScore?: number;
  /** Absolute saving in EUR (originalPrice - currentPrice) when both are known. */
  savingsAbsolute?: number;
  /** Whether the nutrition values are estimated rather than label-accurate. */
  nutritionEstimated?: boolean;
  /** Thin transport projection of the backend ProductAnalysisV2 truth. The app
   *  only displays these — all diet/allergen/nutrition decisions live in Python. */
  productAnalysis?: ProductAnalysisSummary;
}

/** One diet verdict copied from ProductAnalysisV2 (status + confidence + reason). */
export interface DietVerdict {
  status: string;
  confidence: number | null;
  reasonCode: string | null;
}

/** App-facing projection of ProductAnalysisV2 — transport/display only. */
export interface ProductAnalysisSummary {
  version: string | null;
  sourceFingerprint: string | null;
  vegan: DietVerdict;
  vegetarian: DietVerdict;
  halal: DietVerdict;
  reviewNeeded: boolean;
  reviewReasons: string[];
  allergens: { contains: string[]; mayContain: string[]; freeFrom: string[] };
  nutrition: { quality: string | null; basis: string | null; plausible: boolean | null };
  sources: string[];
}

export interface NutritionInfo {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  sugar?: number;
  fiber?: number;
  salt?: number;
  vitamins?: Record<string, number>;
  minerals?: Record<string, number>;
}

export interface RecipeIngredient {
  id: string;
  name: string;
  amount: number;
  unit: string;
  isDeal: boolean;
  dealId?: string;
  dealPrice?: number;
  discountPercent?: number;
  dealStoreName?: string;
  dealName?: string;
  dealValidTo?: string;
  /** Concrete deal extras for the ingredient-deal detail sheet. Optional —
   *  only set when the deal_recipe_matches → deals join carried them. */
  dealImageUrl?: string;
  dealOriginalPrice?: number;
  dealValidFrom?: string;
}

export interface RecipeComment {
  id: string;
  recipeId: string;
  userId: string;
  username: string;
  avatarInitials: string;
  rating: number;
  text: string;
  photoUrl?: string;
  createdAt: string;
}

export type RecipeSourceType =
  | 'human_verified'
  | 'public_domain_adapted'
  | 'ai_generated'
  | 'ai_adapted';

export type RecipeVerificationStatus = 'draft' | 'reviewed' | 'published';

export interface Recipe {
  id: string;
  name: string;
  imageUrl?: string;
  difficulty: Difficulty;
  cookTimeMinutes: number;
  servings: number;
  mealType: MealType;
  ingredients: RecipeIngredient[];
  instructions: string[];
  introText?: string;
  nutritionPerServing?: NutritionInfo;
  swipeAction?: SwipeAction;
  rating?: number;
  ratingCount?: number;
  commentCount?: number;
  createdAt: string;
  // Recipe metadata (migration 20260529000001_recipe_seed_metadata.sql).
  // `cuisine` is the raw DB value (German seed word or slug) — normalize via
  // utils/cuisine before display. All optional so legacy rows keep working.
  cuisine?: string;
  tags?: string[];
  dietFlags?: string[];
  halalStatus?: string;
  // Provenance / review metadata (migration
  // 20260528000001_recipe_sources_and_review.sql). All optional on the
  // client so legacy rows without these columns keep deserialising. Defaults
  // are applied by recipesApi when the column is missing or null.
  sourceType: RecipeSourceType;
  verificationStatus: RecipeVerificationStatus;
  sourceTitle?: string;
  sourceAuthor?: string;
  sourceYear?: number;
  sourceUrl?: string;
  sourceLicense?: string;
  aiNoticeRequired: boolean;
  safetyNotes?: string;
}

export interface ShoppingListItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  storeName?: string;
  price?: number;
  dealId?: string;
  recipeId?: string;
  checked: boolean;
  isManual: boolean;
  purchasedAt?: string;
  pantryItemId?: string;
  createdAt: string;
}

export type PantrySource = 'shopping_list' | 'manual' | 'recipe_residual';

// Where the *product metadata* (barcode/brand/nutrition) came from. Disjoint
// from PantrySource — `source` describes the user action that created the
// pantry row; `lookupSource` describes how we filled in the product fields.
// Overlap is intentional: a row created via shopping list with no scanner
// involvement has lookupSource='shopping_list' and source='shopping_list'.
export type PantryLookupSource =
  | 'manual'
  | 'openfoodfacts'
  | 'shopping_list'
  | 'recipe_residual';

export interface PantryItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  source: PantrySource;
  shoppingItemId?: string;
  dealId?: string;
  addedAt: string;
  consumedAt?: string;
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

export interface WeeklyPlanEntry {
  id: string;
  dayOfWeek: number; // 0=Monday, 6=Sunday
  mealType: MealType;
  recipeId: string;
  recipe: Recipe;
  portionOverride?: number;
}

export interface BodyData {
  gender: Gender;
  heightCm: number;
  weightKg: number;
  bodyFatPercent?: number;
  activityLevel: ActivityLevel;
  /** Optional, only used by the conservative calorie/protein estimate. */
  age?: number;
}

/** High-level diet goal. Drives the conservative calorie/protein hints. */
export type DietGoalType = 'lose' | 'maintain' | 'gain' | 'recomp';

export interface DietGoal {
  targetWeightKg?: number;
  targetBodyFatPercent?: number;
  dailyCalorieTarget?: number;
  autoCalculateCalories: boolean;
  goalModeEnabled?: boolean;
  goalType?: DietGoalType;
  trainingDaysPerWeek?: number;
  /** Daily protein target in grams. Null = use the calculated suggestion. */
  proteinTargetG?: number;
  /** Daily water goal in millilitres. Null = use the default suggestion. */
  waterTargetMl?: number;
}

export interface ProgressEntry {
  id: string;
  date: string;
  weightKg?: number;
  bodyFatPercent?: number;
  notes?: string;
}

/** Tracking bucket for a logged food item (simpler than recipe MealType). */
export type MealCategory = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** One logged food item (meal or snack) on a given day. */
export interface MealLogEntry {
  id: string;
  date: string;
  category: MealCategory;
  name: string;
  recipeId?: string;
  portions?: number;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  /** Self-rated satiety 1–5, optional. */
  satiety?: number;
  /** Whether the nutrition values are estimated rather than label-accurate. */
  nutritionEstimated: boolean;
  createdAt: string;
}

/** Aggregated nutrition totals for a single day, vs. the active targets. */
export interface DailyTrackingSummary {
  date: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  waterMl: number;
  entryCount: number;
}

/** Conservative daily targets derived from body data + goal (or overrides). */
export interface NutritionTargets {
  calories: number;
  protein: number;
  waterMl: number;
  /** True when targets fall back to defaults (body data incomplete). */
  isEstimateOnly: boolean;
  /** Set when the chosen weight-loss pace looks too aggressive. */
  aggressiveWarning?: boolean;
}
