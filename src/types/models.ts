export type TabId = 'offers' | 'aichef' | 'later';

export type LocationMode = 'none' | 'postalCode' | 'gps';

export interface LocationFilter {
  mode: LocationMode;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  radiusKm: number;
}

export interface Offer {
  /** Stable product-family id for favourites. Unlike `id`, this is shared by
   *  the same article across stores, weeks, package sizes and varieties. Older
   *  persisted snapshots may omit it; the offers store backfills it on load. */
  articleId?: string;
  /** Concrete retailer/week offer id. Multiple offers may share articleId. */
  id: string;
  name: string;
  normalizedName: string;
  brand?: string;
  storeId?: string;
  storeAddress?: string;
  storeCity?: string;
  storeChain: string;
  category: string;
  price: number;
  /** Pre-discount price when the source exposes one (e.g. ALDI "Originalpreis"
   *  / a struck-through price). Undefined when unknown — never inferred. */
  originalPrice?: number;
  currency: string;
  unit: string;
  basePrice?: number;
  baseUnit?: string;
  validityStart: string;
  validityEnd: string;
  imageUrl?: string;
  sourceUrl: string;
  region?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  sourceScope?: 'national' | 'local';
  distanceKm?: number;
  tags: string[];
  createdAt: string;
  // Roh-Quellsignale (Task 2): unveränderte Originalwerte aus der Quelle, bevor
  // `category` aufs einfache Set kollabiert wurde — Hilfssignale für die
  // KI/Klassifikation (u. a. internationale Lebensmittel). Optional + additiv,
  // damit bestehende Mobile/Admin-Felder unberührt bleiben.
  sourceCategoryRaw?: string;
  sourceDepartmentRaw?: string;
  sourceTagsRaw?: string[];
  sourceContextRaw?: string;
  /** Stabile Subquellen-/Prospekt-Id, aus der dieses Angebot stammt (z. B.
   *  `lidl:aktionsprospekt-15-06-2026-…`). Erlaubt dem Safety-Gate, einen
   *  partiellen Subquellen-/Prospektverlust GENAU der betroffenen Subquelle
   *  zuzuordnen (Task P5). Optional + additiv; alte Angebote ohne Feld werden
   *  defensiv über Gültigkeitsfenster/URL zugeordnet. */
  sourceId?: string;
}

export interface ShoppingListItem {
  id: string;
  offerId?: string;
  name: string;
  normalizedName: string;
  quantity: number;
  unit: string;
  note: string;
  checked: boolean;
  storeChain?: string;
  category?: string;
  createdAt: string;
}

export interface RecipeIngredient {
  id: string;
  name: string;
  normalizedName: string;
  amount: number;
  unit: string;
  missing: boolean;
  matchedOfferId?: string;
}

export interface Recipe {
  id: string;
  name: string;
  ingredients: RecipeIngredient[];
  instructions: string[];
  servings: number;
  timeMinutes: number;
  missingIngredients: RecipeIngredient[];
  createdAt: string;
}

export interface UserPreferences {
  vegetarian: boolean;
  vegan: boolean;
  halal: boolean;
  allergies: string[];
  noGoIngredients: string[];
}

export interface IngestProgress {
  step:
    | 'idle'
    | 'fetching'
    | 'chunking'
    | 'extracting'
    | 'normalizing'
    | 'saving'
    | 'done'
    | 'error';
  message: string;
  total?: number;
  completed?: number;
}
