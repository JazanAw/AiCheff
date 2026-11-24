# Pantry-Scanner — Plan

> Status: **Phase 1 lokal umgesetzt** (Migration, Types, pantryApi-Erweiterung,
> productLookupApi, pantryMatch, Unit-Tests). Scanner-UI + Rezept-UI + Remote
> noch offen.
> Stand: 2026-05-18.

## Phase 1 — Umsetzungs-Stand (2026-05-18)

| Schritt | Datei | Status |
|---|---|---|
| Migration `pantry_product_metadata` (lokal) | [`supabase/migrations/20260519000001_pantry_product_metadata.sql`](supabase/migrations/20260519000001_pantry_product_metadata.sql) | ✅ angelegt, **nicht** remote gepusht |
| `PantryItem`-Typ erweitert | [`mobile/src/types/index.ts`](mobile/src/types/index.ts) | ✅ neue Felder + neuer `PantryLookupSource` |
| `pantryApi.ts` neue Felder + Scanner-Helfer | [`mobile/src/services/pantryApi.ts`](mobile/src/services/pantryApi.ts) | ✅ inkl. `findActivePantryItemByBarcode` + `incrementPantryItemQuantity` |
| Open Food Facts Lookup | [`mobile/src/services/productLookupApi.ts`](mobile/src/services/productLookupApi.ts) | ✅ mit Locale-Fallback, Timeout, gekürztem `rawProductPayload` |
| Pantry-Match-Util | [`mobile/src/utils/pantryMatch.ts`](mobile/src/utils/pantryMatch.ts) | ✅ `normalizeFoodName` + `isIngredientCoveredByPantry` + `splitMissingIngredients` |
| Unit-Tests | [`mobile/src/services/productLookupApi.test.ts`](mobile/src/services/productLookupApi.test.ts), [`mobile/src/utils/pantryMatch.test.ts`](mobile/src/utils/pantryMatch.test.ts) | ✅ 15 + 16 Tests, alle grün |
| vitest `include` um `mobile/src/**/*.test.ts` erweitert | [`vite.config.ts`](vite.config.ts) | ✅ |

**Bewusst NICHT in Phase 1:**

- `expo-camera` ist **weiterhin nicht installiert** — kommt erst mit Scanner-UI.
- Keine Kamera-/Scanner-Screens.
- Keine Anpassungen in `RecipeDetailScreen` / `CheffityScreen`.
- Kein `supabase db push`, kein Function-Deploy, keine Stripe-Aktionen.

**Nächste Phasen:**

1. **Phase 2 — Scanner-UI:** `expo-camera` installieren (nach OK),
   `ScanPantryItemScreen` + `ConfirmPantryItemScreen` als Modals im
   ShoppingListScreen, i18n-Keys `pantry.scan.*`.
2. **Phase 3 — Rezept-Abgleich:** `splitMissingIngredients` in
   `RecipeDetailScreen` einbauen, „im Lager"-Marker, „Fehlende zur
   Einkaufsliste"-Button.
3. **Phase 4 — Remote:** Migration `supabase db push` (nach explizitem OK).
4. **Phase 5 (optional):** Cheffity add-to-plan filtert Pantry-Matches aus
   Shopping-Add raus; Reranking.

---
> Bezug: ergänzt das bereits umgesetzte Pantry/Shopping-Modell aus
> [`supabase/migrations/20260509000003_pantry_and_trends.sql`](supabase/migrations/20260509000003_pantry_and_trends.sql)
> und das UI in [`mobile/src/screens/shopping/ShoppingListScreen.tsx`](mobile/src/screens/shopping/ShoppingListScreen.tsx).

---

## 1. Ziel

Der User soll sein Zuhause-Lager (Vorratskammer) in der App sehen und pflegen.
Konkret:

- **Sichtbarkeit:** Pantry-Tab zeigt alle aktuell verfügbaren Lebensmittel
  (Name, Menge, Einheit, optional Marke/Bild/Ablaufdatum).
- **Erfassung per Scan:** User scannt **Barcode/EAN/GTIN** (kein QR-Code,
  Supermarktware ist EAN-13/UPC-A/EAN-8) → App holt Produktdaten von
  Open Food Facts → User bestätigt Menge/Einheit/Ablauf → Item landet in
  `pantry_items`.
- **Rezept-Abgleich:** `RecipeDetailScreen` markiert Zutaten als
  **„vorhanden"** (Pantry-Match) oder **„fehlt"**; ein Button schiebt alle
  fehlenden Zutaten in die Einkaufsliste.
- **KI-Nutzung:** Cheffity/Recipe-Ranking nutzt Pantry als Signal
  (mehr Treffer = höherer Score).

Ausdrücklich **nicht** Ziel dieser Iteration:
- Kalibrierte Mengen-Verbrauchsverfolgung pro Zutat („3 g Salz weniger nach
  Kochen") — das ist eine eigene Roadmap-Stufe.
- Multi-User-Pantry / geteilte Familienhaushalte.
- OCR der Quittung (Receipt-Scan) — separates Feature.

---

## 2. Aktueller Stand (Audit)

### 2.1 DB-Schema — `public.pantry_items`

Aus [`supabase/migrations/20260509000003_pantry_and_trends.sql`](supabase/migrations/20260509000003_pantry_and_trends.sql):

| Feld | Typ | Anmerkung |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → `auth.users` | RLS-Owner |
| `name` | text NOT NULL | Anzeigename, derzeit user-typed |
| `quantity` | numeric(10,3) | > 0 |
| `unit` | text | default `''` |
| `source` | `pantry_source` enum | `shopping_list` / `manual` / `recipe_residual` |
| `shopping_item_id` | uuid | back-ref zur Shopping-List-Zeile |
| `deal_id` | uuid FK → `deals` | optional |
| `added_at` | timestamptz | default now() |
| `consumed_at` | timestamptz | NULL = noch da |
| `expires_at` | date | optional |
| `notes` | text | optional |
| `created_at` / `updated_at` | timestamptz | mit Trigger |

**Indizes:** `(user_id, added_at desc)` + partial `(user_id) where consumed_at is null`.
**RLS:** `pantry_items_self_all` für `authenticated` (`user_id = auth.uid()` oder `is_admin()`).

### 2.2 Mobile Service — [`mobile/src/services/pantryApi.ts`](mobile/src/services/pantryApi.ts)

- `fetchPantryItems({ includeConsumed })` → `PantryItem[]`
- `addPantryItem({ name, quantity, unit, expiresAt, notes })` — manuelle Eingabe
- `markPantryItemConsumed(id)` / `unmarkPantryItemConsumed(id)` / `deletePantryItem(id)`
- Mapping: nur die existierenden Spalten oben.

### 2.3 Mobile UI — [`mobile/src/screens/shopping/ShoppingListScreen.tsx`](mobile/src/screens/shopping/ShoppingListScreen.tsx)

- Zwei Tabs: `list` (Einkaufsliste) + `pantry` (Vorrat).
- Pantry zeigt: Name, Menge × Einheit, Source-Label, addedAt/consumedAt.
- Add-Form ist generisch (Name, Quantity, Unit) — kein Produkt-Metadata-Pfad.
- Kein Scan-Button vorhanden.

### 2.4 Rezept-Detail — [`mobile/src/screens/cheffity/RecipeDetailScreen.tsx`](mobile/src/screens/cheffity/RecipeDetailScreen.tsx)

- `IngredientRow` zeigt `name` + `qty unit` + optional Deal-Preis/Discount.
- **Kein** Pantry-Abgleich, **keine** „vorhanden/fehlt"-Markierung,
  **kein** „Fehlendes auf Einkaufsliste"-Button.
- `RecipeIngredient` aus [`mobile/src/types/index.ts`](mobile/src/types/index.ts):
  `id`, `name`, `amount`, `unit`, `isDeal`, `dealId?`, `dealPrice?`,
  `discountPercent?`. **Kein** canonical key / kein Barcode.

### 2.5 Cheffity-Screen — [`mobile/src/screens/cheffity/CheffityScreen.tsx`](mobile/src/screens/cheffity/CheffityScreen.tsx)

- Swipe-rechts → `PortionModal` → Planner-Slot + Shopping-List-Adds für **alle**
  Zutaten (ohne Pantry-Abgleich). Hier könnten später vorhandene Pantry-Items
  vom Shopping-Add ausgeschlossen werden.

### 2.6 Recipe-API — [`mobile/src/services/recipesApi.ts`](mobile/src/services/recipesApi.ts)

- Zutaten kommen aus `recipe_ingredients` mit Multilang-`name`, `amount`,
  `unit`, `is_potential_deal`, Allergene, halal, alcohol. **Kein** Barcode-
  oder Canonical-Ingredient-Key.

### 2.7 Mobile Dependencies — [`mobile/package.json`](mobile/package.json)

- **`expo-camera` ist NICHT installiert.** Aktuell vorhanden:
  `expo-web-browser`, `expo-linking`, `expo-localization`, `expo-location`,
  `expo-notifications`, `expo-auth-session`, `expo-apple-authentication`,
  `expo-crypto`, `expo-font`, `expo-linear-gradient`, `expo-constants`,
  `expo-splash-screen`, `expo-status-bar`, `@react-native-async-storage`,
  `react-native-svg`, `react-native-reanimated`, `react-native-gesture-handler`,
  `react-native-safe-area-context`.
- Expo SDK ist `~54.0.34`.

### 2.8 Was komplett fehlt

- Kein Barcode-/EAN-/GTIN-Code irgendwo im Repo (gegrept: 0 Treffer in
  `mobile/`).
- Kein Open-Food-Facts-Client.
- Keine Kamera-/Permission-Logik.
- Kein Canonical-Ingredient-Matcher (Name→Pantry).

---

## 3. Benötigte DB-Erweiterung (neue Migration)

> ⚠️ **Bestehende Migration nicht ändern.** Neue Migration anlegen, lokal
> testen, **nicht** remote pushen.

**Dateiname-Vorschlag:**
`supabase/migrations/20260519000001_pantry_product_metadata.sql`

**Inhalt (als ALTER, additiv, keine Defaults die Backfill brauchen):**

| Neue Spalte | Typ | Zweck |
|---|---|---|
| `barcode` | `text` | EAN-13/UPC-A/EAN-8 als String (führende Nullen!) |
| `brand` | `text` | Marke (z. B. „Barilla") |
| `product_name` | `text` | Vom Anbieter gemeldeter Produktname (für Anzeige separat von User-`name`) |
| `category` | `text` | Open-Food-Facts-Hauptkategorie als String, lose, für UI-Grouping |
| `image_url` | `text` | Produktfoto-URL (Open Food Facts CDN) |
| `nutrition` | `jsonb` | Frei-Form-Nährwerte (kcal, protein, carbs, fat, salt, sugar) wie OFF sie liefert |
| `ingredients_text` | `text[]` | Geparste Zutatenliste (für Allergen-/Halal-Heuristik); falls zu unstrukturiert, in v1 nur als `text` halten |
| `raw_product_payload` | `jsonb` | komplette OFF-Antwort (gekürzt) für späteren Debug/Recovery |
| `lookup_source` | `text` | `'openfoodfacts'` / `'manual'` / `'shopping_list'` / `'recipe_residual'` — wer hat die Metadaten gefüllt |

**Index-Vorschlag:**

```sql
create index if not exists pantry_items_user_barcode_idx
  on public.pantry_items (user_id, barcode)
  where barcode is not null;
```

Begründung: Lookup „hab ich dieses Produkt schon im Lager?" nach Scan, für
User-spezifische Dedupe-/Increment-Logik (siehe §10.2 „Doppel-Scan").
Kein **UNIQUE**-Constraint — User darf dasselbe Produkt mehrmals einlagern
(zwei Packungen Milch sind zwei Items mit eigenem `expires_at`).

**RLS:** Keine Änderung nötig. Die bestehende Policy
`pantry_items_self_all` deckt die neuen Spalten automatisch ab.

**Backfill:** keiner — alle Felder sind nullable. Bestehende Zeilen bleiben
unverändert.

---

## 4. Mobile Screens / Navigation

### 4.1 Eintrittspunkt: „Scannen"-Button im Pantry-Tab

In [`ShoppingListScreen.tsx`](mobile/src/screens/shopping/ShoppingListScreen.tsx) bottomBar,
wenn `tab === 'pantry'`, **zusätzlich** zum bestehenden „+ Pantry manuell"
einen zweiten Button „📷 Scannen". Kein neuer Tab, keine Bottom-Nav-Änderung.
(Optional auch im `list`-Tab → scannt direkt in die Shopping-Liste; das ist
**Phase 2**, hier nicht im Scope.)

### 4.2 Stack-Erweiterung

Neuer Native-Stack über dem ShoppingList-Tab — analog zum bestehenden
`ProfileStackNavigator` in
[`MainTabNavigator.tsx`](mobile/src/navigation/MainTabNavigator.tsx).
Aktuell ist `ShoppingListScreen` direkt als Tab-Component eingebunden →
wird auf einen `ShoppingStackNavigator` umgestellt mit Routen:

- `ShoppingMain` → bestehender `ShoppingListScreen`
- `ScanPantryItem` → Scanner (Vollbild)
- `ConfirmPantryItem` → Bestätigungs-Bottom-Sheet oder Vollbild

Alternative für v1 (weniger invasiv): Scanner + Confirm als **Modals**
direkt im `ShoppingListScreen`, ohne neuen Stack. → **Empfehlung:** Modals
in v1, Stack erst bei Bedarf (z. B. wenn Confirm aus dem Rezept-Detail
aufgerufen werden soll).

### 4.3 ScanPantryItemScreen (Modal/Screen)

- Vollbild-Modal.
- `CameraView` (expo-camera) mit `barcodeScannerSettings`.
- Overlay: Schließen-Button (Top-Left), Anweisungstext, Fadenkreuz/Box.
- Auf Permission-Denied: Card mit „Kamera-Berechtigung benötigt" + Pressable
  zu Settings (`Linking.openSettings()`).
- Bei Treffer (`onBarcodeScanned`): Scanner pausieren, `code` (EAN) +
  `type` an Parent → Lookup-Loader → Confirm öffnen.
- **„Manuell eingeben"**-Link als Fallback (öffnet Confirm direkt mit
  leerem Barcode + leerem Lookup-Result).

### 4.4 ConfirmPantryItemScreen / Bottom-Sheet

Felder (vorausgefüllt aus Lookup, alle editierbar):

| Feld | Default | UI |
|---|---|---|
| Produktbild (image_url) | OFF-Bild oder Placeholder | klein, oben |
| Produktname | OFF `product_name` (Lang-Auswahl s. §6.4) | TextInput |
| Marke | OFF `brands` | TextInput |
| Menge | `1` | numerisches TextInput |
| Einheit | OFF-`quantity`-Heuristik (z. B. „g", „ml", „Stück") | Picker oder TextInput |
| Ablaufdatum | leer | DatePicker (optional) |
| Notiz | leer | TextInput (optional) |
| Barcode | gescannt, read-only Anzeige | Caption |

Aktionen:

- **„Einlagern"** (Primary) → `addPantryItem(...)` mit Product-Metadata
  → optimistisches Append im Pantry-State → Schließen → Toast.
- **„Abbrechen"** (Secondary) → Schließen ohne Schreibvorgang.

### 4.5 Pantry-Liste — visuelle Erweiterung

In [`ShoppingListScreen.PantryBody`](mobile/src/screens/shopping/ShoppingListScreen.tsx):

- Falls `item.imageUrl` vorhanden → kleines Thumbnail links vom Checkbox.
  Sonst: bestehendes Checkbox-Verhalten unverändert.
- Unter dem Namen optional `item.brand` als Caption-Zeile.
- Barcode wird nicht angezeigt (zu lang, irrelevant für den User).

---

## 5. Scanner-Flow (End-to-End)

```
[Pantry-Tab] --(Tap "Scannen")--> [ScanPantryItemScreen]
                                          │
                              (Permission prüfen)
                                          │
                       ┌──────────────────┴───────────────────┐
                  granted                                  denied
                       │                                      │
              CameraView aktiv                       Settings-CTA + "Manuell"
                       │
              onBarcodeScanned(code)
                       │
              setLoading(true) + Lookup
                       │
                productLookupApi.lookupProductByBarcode(code)
                       │
            ┌──────────┴──────────┐
        gefunden                nicht gefunden
            │                          │
   ConfirmPantryItem            ConfirmPantryItem
   (prefilled aus OFF)          (leer, name=`Produkt ${barcode}`,
                                 nur barcode + lookup_source='manual')
            │                          │
            └──────────┬───────────────┘
                       │
              [Einlagern] → addPantryItem → Pantry-Liste refresht
```

**Wichtige Details:**

- Scanner-Pause nach erstem Treffer (`barcodeScannerSettings` + lokales
  `useRef(false)`-Lock), sonst feuert das Event mehrfach.
- Nach „Einlagern" oder „Abbrechen" Scanner schließen — kein Auto-Restart,
  weil User typischerweise ein Produkt nach dem anderen scannt.
- Bei Lookup-Netzwerkfehler: Confirm trotzdem öffnen, mit Hinweis
  „Produktdaten nicht ladbar — bitte manuell eingeben".

---

## 6. Open Food Facts Lookup

### 6.1 Service: neue Datei

`mobile/src/services/productLookupApi.ts`

### 6.2 Signatur

```ts
export interface ProductLookupResult {
  found: boolean;
  barcode: string;
  productName?: string;
  brand?: string;
  category?: string;
  imageUrl?: string;
  quantityText?: string;       // raw "500 g", für UI-Heuristik
  defaultQuantity?: number;    // geparst aus quantityText
  defaultUnit?: string;        // 'g' | 'ml' | 'Stück' | ''
  nutrition?: Record<string, number | undefined>;
  ingredientsText?: string;
  rawPayload?: unknown;        // gekürzt — siehe §6.5
}

export async function lookupProductByBarcode(
  barcode: string,
): Promise<ProductLookupResult>;
```

### 6.3 API-Call

- Endpoint: `GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json`
- `User-Agent`-Header setzen (OFF ToS): z. B. `Cheffity/1.0 (https://cheffity.app)`.
- Timeout via `AbortController` (z. B. 6 s) — UI darf nicht hängen.
- Response-Codes:
  - `status: 1` → Produkt gefunden, `product`-Objekt parsen.
  - `status: 0` oder HTTP 404 → `found: false` zurückgeben (kein Throw).
  - Netzwerkfehler / Timeout → Throw, UI zeigt Hinweis.

### 6.4 Mapping (Multilang)

OFF liefert Felder wie `product_name_de`, `product_name_en`, `product_name`.
Priorität für `productName`:

1. `product_name_de`
2. `product_name_en`
3. `product_name`
4. fallback: `generic_name_de` / `generic_name`
5. `brands` als letzter Notnagel

Für `category` analog `categories_tags` → ersten lesbaren Wert nehmen
(z. B. `en:dairy-products` → `dairy-products` → in DE-Label übersetzen
**später**, in v1 raw speichern).

`quantity` (z. B. `"500 g"`) per Regex parsen → `defaultQuantity = 500`,
`defaultUnit = 'g'`. Unparsebare Werte → `defaultQuantity = 1`,
`defaultUnit = ''`.

`nutriments` (kcal pro 100 g): nur die Standardfelder mappen
(`energy-kcal_100g`, `proteins_100g`, `carbohydrates_100g`, `fat_100g`,
`sugars_100g`, `salt_100g`). Keine Vitamine/Mineralien in v1.

### 6.5 `rawPayload` schlank halten

OFF-Responses sind > 100 KB. Vor dem Speichern in `pantry_items.raw_product_payload`
**nur ausgewählte Felder** behalten (`product_name*`, `brands`,
`categories_tags`, `image_url`, `nutriments`, `quantity`,
`ingredients_text*`). Sonst bläht das die Pantry-Tabelle auf.

### 6.6 Caching

Optional, nicht in v1: gleicher Barcode innerhalb 24 h → aus AsyncStorage
zurückgeben. In v1 jeder Scan = ein API-Call (typische Häufigkeit ist
niedrig).

### 6.7 ToS / Rate Limit

OFF ist kostenlos, aber:

- Realistic Rate-Limit: ~100 req/min pro IP. Für eine Single-User-App
  völlig unkritisch.
- User-Agent ist **Pflicht** (OFF docs).
- Keine Auth nötig für reads.

---

## 7. Manuelle Fallback-Eingabe

Wenn Lookup `found: false` zurückgibt **oder** der User bewusst
„Manuell eingeben" wählt:

- Confirm öffnet sich mit:
  - `barcode` = gescannter Code (falls vorhanden), sonst leer
  - `productName` = leer, Placeholder „Produktname"
  - `brand`, `category`, `imageUrl`, `nutrition` = leer
  - `defaultQuantity` = 1, `defaultUnit` = leer
  - `lookup_source` = `'manual'`
- User füllt Felder selbst aus.
- „Einlagern" schreibt mit den User-Werten + Barcode (falls vorhanden) in
  `pantry_items`. Kein Versuch, OFF nochmal zu fragen.

**UI-Hinweis** bei Confirm-Open mit `found=false`:
> „Produkt nicht in der Datenbank gefunden — bitte Felder selbst ausfüllen.
> Wir merken uns den Barcode."

---

## 8. Mengen-/Einheiten-Auswahl

Kein eigenes komplettes UoM-System in v1. Pragmatisch:

- **Einheit:** Free-Text TextInput **plus** Quick-Chips
  (`g`, `kg`, `ml`, `l`, `Stück`). Tap auf Chip setzt das Input-Feld.
- **Menge:** numerisches TextInput, default aus OFF-Parser oder `1`.
- Validierung: `quantity > 0` (matcht DB-Check).
- Konvertierung (`500 g` ↔ `0.5 kg`) **nicht** in v1. Wir speichern, was
  der User tippt; der Recipe-Match arbeitet name-basiert, nicht mengen-
  basiert.

---

## 9. Rezept-Zutaten-Abgleich

### 9.1 Match-Strategie (v1, pragmatisch)

Name-basiert mit Normalisierung. Kein DB-Join, kein Canonical-Key — Pantry
und Recipe-Ingredients teilen sich kein Schema.

**Normalisierung** (clientseitig, neue Util `mobile/src/utils/pantryMatch.ts`):

- `name.toLowerCase()`
- Trim + Whitespace-Collapse
- Bindestriche/Punkte entfernen
- Deutsche Pluralformen heuristisch trimmen
  (`-en`, `-er`, `-e`, `-s` am Wortende — nicht perfekt, aber „Tomaten" ≈ „Tomate")
- Marken-Wörter rausfiltern? → in v1 **nein**, das ist Over-Engineering.
  „Barilla Spaghetti" matcht nicht auf „Spaghetti", das ist akzeptabel
  in v1.

**Match-Funktion:**

```ts
export function findPantryMatch(
  ingredientName: string,
  pantry: PantryItem[],
): PantryItem | null;
```

Return: erstes Pantry-Item mit `normalizedName === normalize(ingredient.name)`
**oder** mit Substring-Match auf gemeinsamem Wortstamm. Falls mehrere
matchen, das zuletzt hinzugefügte (`addedAt desc`) bevorzugen.

`consumed_at != null` → nicht matchen.

### 9.2 Rezept-Detail UI-Erweiterung

In [`RecipeDetailScreen.IngredientRow`](mobile/src/screens/cheffity/RecipeDetailScreen.tsx):

- Vor dem Namen ein kleiner Status-Dot oder Check-Icon:
  - ✅ grün, wenn `pantryMatch != null` → Text-Suffix „im Lager"
  - ⚪ neutral, wenn kein Match
- Optional: durchgestrichener Style für Pantry-Matches, damit der User
  sofort sieht „muss ich nicht kaufen".

Pantry-Daten werden im `DetailContent` einmal geladen
(`fetchPantryItems({ includeConsumed: false })`) und an die Zutatenliste
durchgereicht.

### 9.3 „Fehlendes auf Einkaufsliste"-Button

Neuer Button unter der Zutatenliste (Tab `recipe`):

> **„Fehlende Zutaten zur Einkaufsliste"** (n)

Verhalten: für jede Zutat ohne Pantry-Match → `addShoppingItem({ name,
quantity: amount, unit, recipeId })` (Logik analog zu
[`CheffityScreen.handlePortionConfirm`](mobile/src/screens/cheffity/CheffityScreen.tsx),
aber **gefiltert** auf nicht-vorhandene Zutaten).
Toast: „n Zutaten zur Liste hinzugefügt".

### 9.4 CheffityScreen — Filter beim Add-to-Plan

In [`CheffityScreen.handlePortionConfirm`](mobile/src/screens/cheffity/CheffityScreen.tsx)
analog: vor dem `addShoppingItem`-Loop Pantry laden und Matches
**überspringen**. Optional, kann in derselben Iteration mitgemacht werden.

---

## 10. KI-/Cheffity-Nutzung der Pantry-Daten

### 10.1 Ranking-Signal (später, Phase 2)

`fetchRecipes` aktuell sortiert nach `rating` + `created_at`. Erweiterung:

- Pantry einmal beim CheffityScreen-Mount laden.
- Pro Recipe `pantryMatchCount = ingredients.filter(i => findPantryMatch(...)).length`.
- Score-Mixer:
  `finalScore = rating * 0.6 + (pantryMatchCount / ingredients.length) * 0.4`.
- Sortierung nach `finalScore desc`.

Diese Reranking-Logik ist **clientseitig**, kein DB-Change. Phase-1-Scope
ist nur das „sichtbar machen" (§9). Reranking kommt nach.

### 10.2 LLM-Kontext (später, Phase 2)

`recipeGeneration` im Backend könnte Pantry-Items als „Vorhanden im Haushalt"-
Liste in den Prompt mitgeben, damit Vorschläge Pantry-Items priorisieren.
Out of scope hier.

### 10.3 Doppel-Scan / Increment-Heuristik

Wenn beim Scan derselbe `barcode` schon mit `consumed_at IS NULL` existiert:
**zwei Pfade** (Produktentscheidung, v1 = Pfad A):

- **A (default v1):** Neue Pantry-Zeile anlegen — User hat zwei Packungen
  mit jeweils eigenem Ablaufdatum.
- **B (optional v2):** Confirm-Sheet zeigt „Bereits im Lager: 1× — addieren?"
  → Update `quantity += new`. Komplexer (Unit-Mismatch), erstmal nicht.

---

## 11. Scanner-Technik

### 11.1 Library-Entscheidung

**Empfehlung: `expo-camera`** (Standard im Expo-Universum, ersetzt das
deprecated `expo-barcode-scanner`).

- **Aktuell NICHT installiert** (siehe [§2.7](#27-mobile-dependencies--mobilepackagejson)).
- Install (erst nach OK):
  ```bash
  npm --prefix mobile install expo-camera
  ```
- Expo-Plugin-Eintrag in
  [`mobile/app.json`](mobile/app.json) ergänzen (`expo-camera` mit
  `cameraPermission`-String). Beispiel:
  ```json
  "plugins": [
    ["expo-camera", {
      "cameraPermission": "Cheffity darf die Kamera nutzen, um Produkt-Barcodes zu scannen."
    }]
  ]
  ```
- iOS: `NSCameraUsageDescription` wird vom Plugin automatisch ins
  `Info.plist` gesetzt — verifizieren beim ersten Prebuild.
- Android: `android.permission.CAMERA` wird vom Plugin automatisch
  ergänzt.

### 11.2 API-Skizze

```tsx
import { CameraView, useCameraPermissions } from 'expo-camera';

const [permission, requestPermission] = useCameraPermissions();
const lockRef = useRef(false);

<CameraView
  style={StyleSheet.absoluteFill}
  facing="back"
  barcodeScannerSettings={{
    barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128'],
  }}
  onBarcodeScanned={({ data, type }) => {
    if (lockRef.current) return;
    lockRef.current = true;
    onScanned(data, type);
  }}
/>
```

QR-Code-Typen (`qr`) sind bewusst **nicht** in der Liste — Supermarktware
ist EAN/UPC. (UI darf trotzdem „Scannen" heißen.)

### 11.3 Web-Fallback

Expo-Camera funktioniert im Web nur eingeschränkt; in v1 ist Web kein
Ziel-Target (Cheffity ist Mobile-first). Im Web → Scanner-Button
deaktiviert + Hinweis „Scan nur in der App".

---

## 12. Edge Cases

| Fall | Verhalten |
|---|---|
| Kamera-Permission denied | Card „Berechtigung in Settings aktivieren" + `Linking.openSettings()` + Link „Manuell eingeben". |
| Scan-Code wird nicht erkannt (verzerrt, Schatten) | Kein Throw — Scanner läuft weiter; User-Hinweis nach 10 s Inaktivität: „Code halten oder manuell eingeben". |
| OFF-Lookup Timeout | Confirm mit `found: false` öffnen + Banner „Offline / OFF nicht erreichbar". |
| OFF liefert leere Felder (Produkt registriert aber unvollständig) | Confirm zeigt nur was da ist, Rest leer / Placeholder. |
| Barcode mit führender Null (EAN-13 = 13 Zeichen) | als `string` halten, **nie** in `number` casten — sonst geht die Null verloren. DB-Spalte ist `text`. |
| Doppel-Scan desselben Codes | v1: zwei Zeilen (siehe §10.3). |
| User scannt Pfand-Barcode auf Flasche statt Produkt-EAN | Wird OFF nicht finden → Manuell-Fallback. Akzeptabel. |
| `expo-camera` nicht gebaut (Dev-Build vs. Expo Go) | Expo Go ab SDK 51 unterstützt expo-camera; SDK 54 läuft. Falls Issues: Custom Dev Client nötig (separates Build-Ticket). |
| Pantry-Item ohne `barcode` (manuell angelegt) | Match weiterhin name-basiert — kein Bruch. |
| Pantry sehr groß (>500 Items) | `findPantryMatch` ist O(n*m), n=Rezeptzutaten, m=Pantry. Bei m=500, n=20 → 10k Vergleiche — vernachlässigbar. Erst optimieren wenn Problem. |
| Rezept mit „Salz nach Geschmack" (amount=0) | Bestehender Code in CheffityScreen behandelt das (`quantity > 0 ? scaled : 1`) — bleibt unverändert. Bei Pantry-Match nichts spezielles tun. |

---

## 13. Tests

### 13.1 Unit-Tests (vitest, im bestehenden Setup)

**`mobile/src/services/productLookupApi.test.ts`** (neu) — Mapping-Tests:

- OFF-Response (Fixture mit `product_name_de`) → korrektes Mapping.
- OFF-Response ohne `product_name_de`, mit `product_name_en` → Fallback.
- OFF-Response mit `status: 0` → `found: false`, kein Throw.
- `quantity: "500 g"` → `defaultQuantity: 500`, `defaultUnit: 'g'`.
- `quantity: "1 L"` → `defaultUnit: 'l'`.
- `quantity: "12 x 33 cl"` (Mehrpackung) → akzeptiere `defaultQuantity: 1`,
  `defaultUnit: ''` als „unparseable" — kein Fehler.
- `nutriments`-Subset wird korrekt extrahiert.
- `rawPayload`-Whitelist greift (großes Payload wird gekürzt).

**`mobile/src/utils/pantryMatch.test.ts`** (neu):

- Exakter Match: `"Tomate"` ↔ `"tomate"`.
- Plural-Heuristik: `"Tomaten"` ↔ `"Tomate"`.
- Substring-Match: `"Bio Tomaten"` ↔ `"Tomate"`.
- Kein Match: `"Tomate"` ↔ `"Gurke"`.
- Consumed-Items werden ignoriert.
- Mehrere Matches → letzter (jüngster `addedAt`) wird zurückgegeben.

### 13.2 Typecheck

`npm run mobile:typecheck` — nach jeder Implementierungs-Iteration.

### 13.3 Manuelle Mobile-Tests

| Szenario | Erwartung |
|---|---|
| Barcode bekannt (z. B. Barilla Spaghetti EAN) | Confirm prefilled, „Einlagern" landet in Pantry mit `lookup_source='openfoodfacts'`. |
| Barcode unbekannt | Confirm mit Hinweis, leere Felder, `lookup_source='manual'`. |
| Kamera-Permission denied beim ersten Open | Settings-CTA sichtbar, „Manuell eingeben" funktioniert. |
| Quantity ändern, dann Einlagern | Geänderter Wert landet in DB. |
| Pantry-Liste zeigt neues Item sofort | Optimistic Update + Refetch nach Confirm-Close. |
| Rezept öffnen, das eine Pantry-Zutat hat | „im Lager"-Marker sichtbar. |
| „Fehlende zur Einkaufsliste" tappen | Nur Nicht-Pantry-Zutaten erscheinen in der Shopping-Liste. |
| Doppel-Scan desselben Codes | Zwei Pantry-Zeilen. |
| Offline-Scan | Confirm öffnet mit Offline-Banner, manuelle Eingabe möglich. |

### 13.4 DB-Test (lokal)

- Migration lokal anwenden: `supabase db reset` (lokales Supabase, **nicht**
  remote).
- Smoke: `insert into pantry_items (user_id, name, quantity, unit, source,
  barcode, brand, product_name) values (...)` → läuft durch, RLS gilt.

---

## 14. Akzeptanzkriterien

1. ✅ Neue Migration `pantry_product_metadata` liegt **lokal** im Repo und
   ist syntaktisch korrekt (lokales `supabase db reset` läuft sauber). Nicht
   remote gepusht.
2. ✅ Pantry-Tab hat einen sichtbaren „Scannen"-Button.
3. ✅ Scan eines bekannten EAN-13 öffnet Confirm-Sheet mit Produktbild,
   Produktname (de bevorzugt), Marke, geparster Menge/Einheit.
4. ✅ Scan eines unbekannten Codes öffnet Confirm mit Hinweis + leeren
   Feldern + persistiertem Barcode.
5. ✅ „Einlagern" schreibt eine `pantry_items`-Zeile mit `barcode`,
   `brand`, `product_name`, `image_url`, `nutrition`, `lookup_source` und
   den User-bestätigten `quantity`/`unit`.
6. ✅ Pantry-Liste rendert Produktbild (falls vorhanden) + Marke als
   Subzeile.
7. ✅ `RecipeDetailScreen` markiert Zutaten als „im Lager", wenn ein
   passendes Pantry-Item existiert (Name-Match, `consumed_at IS NULL`).
8. ✅ Button „Fehlende zur Einkaufsliste" fügt **nur** Zutaten ohne
   Pantry-Match hinzu.
9. ✅ Kamera-Permission denied führt nicht zu Crash; Settings-CTA + Manual-
   Fallback funktionieren.
10. ✅ `npm run lint`, `npm test -- --run`, `npm run mobile:typecheck`,
    `npm run build`, `npm --prefix admin run build` sind grün.
11. ✅ Keine `supabase db push`, kein Function-Deploy, keine
    Stripe-Aktionen.

---

## 15. Reihenfolge der Umsetzung

> Idee: in fünf eigenständigen Schritten, jeder PR-fähig. Bei Bedarf
> Stop-Punkte vor 11.5/11.6 für Review.

### Schritt 1 — DB-Migration (lokal)

- Neue Migration `20260519000001_pantry_product_metadata.sql` schreiben.
- Lokal anwenden + Smoke-Insert.
- Typecheck/Tests grün.
- **Stop:** vor remote push.

### Schritt 2 — Mobile-Typen + Service

- `mobile/src/types/index.ts`: `PantryItem` um `barcode`, `brand`,
  `productName`, `category`, `imageUrl`, `nutrition`, `ingredientsText`,
  `lookupSource` erweitern.
- `mobile/src/services/pantryApi.ts`: `mapRow` + `addPantryItem` um neue
  Felder erweitern (alles optional, kein Breaking Change für bestehende
  manuelle Pantry-Adds).
- `productLookupApi.ts` + Unit-Tests (kein UI-Code).
- `pantryMatch.ts` + Unit-Tests.
- Gates grün.

### Schritt 3 — Scanner + Confirm UI (hinter Feature-Flag falls nötig)

- `expo-camera` installieren (nach explizitem OK).
- `app.json` Plugin-Eintrag.
- `ScanPantryItemScreen` + `ConfirmPantryItemScreen` (als Modals im
  ShoppingListScreen).
- Pantry-Liste: Thumbnail + Brand-Zeile.
- i18n-Keys `pantry.scan.*` in `de` und `en` (mindestens beide).
- Manueller Test auf physischem Gerät (Expo Go oder Dev-Build).

### Schritt 4 — Rezept-Abgleich

- `RecipeDetailScreen`: Pantry laden, IngredientRow erweitern, „Fehlende
  zur Einkaufsliste"-Button.
- i18n-Keys `cheffity.detail.inPantry` etc.
- Manueller Test: Pantry-Item anlegen → Rezept öffnen → Marker sichtbar.

### Schritt 5 — Cheffity-Reranking (optional, Phase 2)

- `CheffityScreen` add-to-plan filtert Pantry-Matches aus dem Shopping-Add
  raus.
- Optional: Score-Mixer mit Pantry-Match-Anteil.
- **Kein** Backend-/Prompt-Change in dieser Stufe.

---

## 16. Was bewusst NICHT in dieser Iteration ist

- Stripe / Subscriptions (eigene Roadmap, siehe
  [`stripe-integration.md`](stripe-integration.md)).
- Receipt-OCR.
- Geteilter Haushalts-Pantry.
- Echte Verbrauchsverfolgung pro Kochvorgang (nur „consumed"-Flag, keine
  Mengen-Subtraktion).
- Backend-LLM-Prompt-Erweiterung um Pantry-Kontext.
- Web-Scanner (Cheffity ist mobile-first; Web ohne Scan-Funktion).
- Custom Canonical-Ingredient-Tabelle / Strukturiertes UoM-System.

---

## 17. Offene Entscheidungen (für dich)

1. **Doppel-Scan-Verhalten** (§10.3): v1 = zwei Zeilen, oder doch Increment?
2. **Phase-2-Scope:** Cheffity-Reranking sofort mit oder eigene Runde?
3. **`expo-camera` installieren:** ja / nein? (Bedingung für Schritt 3.)
4. **Sprach-Priorisierung in OFF-Mapping:** nur `de`-bevorzugen, oder
   User-Locale aus `i18next` lesen? (Empfehlung: User-Locale.)
5. **Migration jetzt schreiben oder erst nach Mobile-Plan-Review?**
   (Empfehlung: schreiben, lokal testen, dann committen — kein Remote.)
