import { useEffect, useMemo, useRef, useState } from 'react';
import { AiChefTab } from './components/chef/AiChefTab';
import { OffersTab } from './components/offers/OffersTab';
import { OfferFiltersState } from './components/offers/types';
import { ShoppingListSection } from './components/shopping/ShoppingListSection';
import { TabNav } from './components/TabNav';
import { useLocalStorageState } from './hooks/useLocalStorageState';
import {
  fetchOffersFromBackend,
  refreshOffersFromBackend,
} from './services/offersApi';
import {
  generateRecipesFromOffers,
  recipeIngredientsToShoppingItems,
} from './services/recipes/recipeGenerator';
import { storageKeys } from './services/storage';
import {
  IngestProgress,
  LocationFilter,
  Offer,
  Recipe,
  ShoppingListItem,
  TabId,
  UserPreferences,
} from './types/models';
import {
  dedupeOffersByBestPrice,
  isLikelyFoodOffer,
  isOfferInCurrentWeek,
  isOfferMatchingLocation,
  normalizeText,
} from './utils/offers';

const defaultPreferences: UserPreferences = {
  vegetarian: false,
  vegan: false,
  halal: false,
  allergies: [],
  noGoIngredients: [],
};

const defaultLocationFilter: LocationFilter = {
  mode: 'none',
  postalCode: '',
  latitude: null,
  longitude: null,
  radiusKm: 40,
};

const defaultOfferFilters: OfferFiltersState = {
  store: 'all',
  category: 'all',
  scope: 'all',
  search: '',
  selectedTags: [],
  onlyFood: true,
  onlyCurrentWeek: true,
};

type ThemeMode = 'light' | 'dark';

interface UiSettingsState {
  theme: ThemeMode;
  loginEmail: string;
  isLoggedIn: boolean;
  preferredPostalCode: string;
}

const defaultUiSettings: UiSettingsState = {
  theme: 'light',
  loginEmail: '',
  isLoggedIn: false,
  preferredPostalCode: '',
};

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

function toShoppingListItemFromOffer(offer: Offer): ShoppingListItem {
  return {
    id: createId('shopping'),
    offerId: offer.id,
    name: offer.name,
    normalizedName: offer.normalizedName,
    quantity: 1,
    unit: offer.unit,
    note: '',
    checked: false,
    storeChain: offer.storeChain,
    category: offer.category,
    createdAt: new Date().toISOString(),
  };
}

function getOfferSourceScope(offer: Offer): 'national' | 'local' {
  if (offer.sourceScope === 'local' || offer.storeId) {
    return 'local';
  }
  return 'national';
}

function mergeShoppingItems(
  currentItems: ShoppingListItem[],
  incomingItems: ShoppingListItem[],
): ShoppingListItem[] {
  const merged = [...currentItems];
  for (const incomingItem of incomingItems) {
    const existingIndex = merged.findIndex(
      (item) =>
        item.normalizedName === incomingItem.normalizedName &&
        item.storeChain === incomingItem.storeChain &&
        !item.checked,
    );

    if (existingIndex >= 0) {
      merged[existingIndex] = {
        ...merged[existingIndex],
        quantity: merged[existingIndex].quantity + incomingItem.quantity,
      };
      continue;
    }

    merged.push(incomingItem);
  }
  return merged;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('offers');

  const [offers, setOffers] = useLocalStorageState<Offer[]>(storageKeys.offers, []);
  const [shoppingList, setShoppingList] = useLocalStorageState<ShoppingListItem[]>(
    storageKeys.shoppingList,
    [],
  );
  const [preferences, setPreferences] = useLocalStorageState<UserPreferences>(
    storageKeys.userPreferences,
    defaultPreferences,
  );
  const [recipes, setRecipes] = useLocalStorageState<Recipe[]>(storageKeys.recipes, []);
  const [locationFilter, setLocationFilter] = useLocalStorageState<LocationFilter>(
    storageKeys.location,
    defaultLocationFilter,
  );
  const [uiSettings, setUiSettings] = useLocalStorageState<UiSettingsState>(
    storageKeys.uiSettings,
    defaultUiSettings,
  );

  const [offerFilters, setOfferFilters] = useState<OfferFiltersState>(
    defaultOfferFilters,
  );
  const [listOpen, setListOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPostalCode, setSettingsPostalCode] = useState('');
  const [loginEmailInput, setLoginEmailInput] = useState('');
  const [loginPasswordInput, setLoginPasswordInput] = useState('');
  const [settingsInfo, setSettingsInfo] = useState<string | null>(null);
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress>({
    step: 'idle',
    message: 'Bereit',
  });
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestWarnings, setIngestWarnings] = useState<string[]>([]);

  const [aiChefLoading, setAiChefLoading] = useState(false);
  const [aiChefError, setAiChefError] = useState<string | null>(null);
  const [aiChefWarnings, setAiChefWarnings] = useState<string[]>([]);
  const lastBackendUpdatedAtRef = useRef<string | null>(null);

  const filteredOffers = useMemo(() => {
    const normalizedSearch = normalizeText(offerFilters.search);

    const filtered = offers
      .filter((offer) => {
        if (offerFilters.store !== 'all' && offer.storeChain !== offerFilters.store) {
          return false;
        }

        if (
          offerFilters.category !== 'all' &&
          offer.category !== offerFilters.category
        ) {
          return false;
        }

        if (
          offerFilters.scope !== 'all' &&
          getOfferSourceScope(offer) !== offerFilters.scope
        ) {
          return false;
        }

        if (offerFilters.onlyFood && !isLikelyFoodOffer(offer)) {
          return false;
        }

        if (offerFilters.onlyCurrentWeek && !isOfferInCurrentWeek(offer, new Date())) {
          return false;
        }

        if (offerFilters.selectedTags.length > 0) {
          const hasAllTags = offerFilters.selectedTags.every((tag) =>
            offer.tags.includes(tag),
          );
          if (!hasAllTags) {
            return false;
          }
        }

        if (normalizedSearch.length > 0) {
          const searchable = `${offer.normalizedName} ${normalizeText(offer.category)} ${offer.tags.join(' ')}`;
          if (!searchable.includes(normalizedSearch)) {
            return false;
          }
        }

        return isOfferMatchingLocation(offer, locationFilter);
      });

    const collapsed =
      offerFilters.store === 'all'
        ? dedupeOffersByBestPrice(filtered)
        : filtered;

    return collapsed.sort((left, right) => left.price - right.price);
  }, [locationFilter, offerFilters, offers]);

  const openShoppingCount = useMemo(
    () => shoppingList.filter((item) => !item.checked).length,
    [shoppingList],
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', uiSettings.theme);
  }, [uiSettings.theme]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    setSettingsPostalCode(
      locationFilter.postalCode || uiSettings.preferredPostalCode || '',
    );
    setLoginEmailInput(uiSettings.loginEmail);
    setLoginPasswordInput('');
    setSettingsInfo(null);
  }, [
    settingsOpen,
    locationFilter.postalCode,
    uiSettings.preferredPostalCode,
    uiSettings.loginEmail,
  ]);

  useEffect(() => {
    const loadOffers = async (): Promise<void> => {
      try {
        const response = await fetchOffersFromBackend();
        lastBackendUpdatedAtRef.current = response.updatedAt;
        setOffers(response.offers);
        setIngestWarnings(response.warnings);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Backend fuer Angebote nicht erreichbar.';
        setIngestError(message);
      }
    };

    void loadOffers();
  }, [setIngestError, setIngestWarnings, setOffers]);

  useEffect(() => {
    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetchOffersFromBackend();
        setIngestWarnings(response.warnings);

        if (
          response.updatedAt &&
          response.updatedAt !== lastBackendUpdatedAtRef.current
        ) {
          lastBackendUpdatedAtRef.current = response.updatedAt;
          setOffers(response.offers);
          setIngestProgress({
            step: 'done',
            message: `Neue Angebote synchronisiert (${response.offers.length}).`,
            total: response.offers.length,
            completed: response.offers.length,
          });
        }
      } catch {
        // Polling should stay silent to avoid noisy UX when backend is restarting.
      }
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [setIngestProgress, setIngestWarnings, setOffers]);

  const handleRefreshOffers = async (): Promise<void> => {
    setIngestLoading(true);
    setIngestError(null);
    setIngestWarnings([]);
    setIngestProgress({
      step: 'fetching',
      message: 'Backend startet Angebotsermittlung...',
    });

    try {
      const result = await refreshOffersFromBackend(locationFilter, true);
      setIngestProgress({
        step: 'saving',
        message: 'Angebote vom Backend werden in der App aktualisiert...',
      });

      if (result.offers.length === 0) {
        setIngestError('Keine Angebote gefunden.');
      }

      lastBackendUpdatedAtRef.current = result.updatedAt;
      setOffers(result.offers);
      setIngestWarnings(result.warnings);
      setIngestProgress({
        step: 'done',
        message: `Fertig. ${result.offers.length} Angebote gespeichert.`,
        total: result.offers.length,
        completed: result.offers.length,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unbekannter Ingest-Fehler';
      setIngestProgress({
        step: 'error',
        message: 'Fehler beim Laden der Angebote.',
      });
      setIngestError(message);
    } finally {
      setIngestLoading(false);
    }
  };

  const handleRequestGps = async (): Promise<void> => {
    if (!('geolocation' in navigator)) {
      setIngestError('GPS wird vom Browser nicht unterstuetzt.');
      return;
    }

    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 8000,
      });
    }).catch((error: GeolocationPositionError) => {
      setIngestError(`GPS konnte nicht gelesen werden: ${error.message}`);
      return null;
    });

    if (!position) {
      return;
    }

    setLocationFilter({
      ...locationFilter,
      mode: 'gps',
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });
    setIngestError(null);
  };

  const handleThemeChange = (theme: ThemeMode): void => {
    setUiSettings((current) => ({
      ...current,
      theme,
    }));
  };

  const handleSavePostalCode = (): void => {
    const postalCode = settingsPostalCode.replace(/[^\d]/g, '').slice(0, 5);
    setUiSettings((current) => ({
      ...current,
      preferredPostalCode: postalCode,
    }));

    setLocationFilter((current) => ({
      ...current,
      mode: postalCode.length > 0 ? 'postalCode' : 'none',
      postalCode,
    }));

    setSettingsInfo(
      postalCode.length > 0
        ? `PLZ ${postalCode} gespeichert.`
        : 'PLZ entfernt. Standortfilter steht auf "Ohne Standort".',
    );
  };

  const handleLogin = (): void => {
    const loginEmail = loginEmailInput.trim();
    if (!loginEmail || !loginPasswordInput.trim()) {
      setSettingsInfo('Bitte E-Mail und Passwort eingeben.');
      return;
    }

    setUiSettings((current) => ({
      ...current,
      isLoggedIn: true,
      loginEmail,
    }));
    setLoginPasswordInput('');
    setSettingsInfo(`Eingeloggt als ${loginEmail}.`);
  };

  const handleLogout = (): void => {
    setUiSettings((current) => ({
      ...current,
      isLoggedIn: false,
    }));
    setLoginPasswordInput('');
    setSettingsInfo('Du wurdest ausgeloggt.');
  };

  const handleAddOfferToShoppingList = (offer: Offer): void => {
    const item = toShoppingListItemFromOffer(offer);
    setShoppingList((currentItems) => mergeShoppingItems(currentItems, [item]));
  };

  const handleToggleShoppingItem = (itemId: string): void => {
    setShoppingList((items) =>
      items.map((item) =>
        item.id === itemId ? { ...item, checked: !item.checked } : item,
      ),
    );
  };

  const handleUpdateShoppingItem = (
    itemId: string,
    patch: Partial<ShoppingListItem>,
  ): void => {
    setShoppingList((items) =>
      items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    );
  };

  const handleRemoveShoppingItem = (itemId: string): void => {
    setShoppingList((items) => items.filter((item) => item.id !== itemId));
  };

  const handleGenerateRecipes = async (): Promise<void> => {
    setAiChefLoading(true);
    setAiChefError(null);
    setAiChefWarnings([]);

    try {
      const result = await generateRecipesFromOffers(offers, preferences, true);
      setRecipes(result.recipes);
      setAiChefWarnings(result.warnings);
      if (result.recipes.length === 0) {
        setAiChefError('Es konnten keine Rezepte erstellt werden.');
      }
    } catch (error) {
      setAiChefError(
        error instanceof Error ? error.message : 'Unbekannter AIChef-Fehler',
      );
    } finally {
      setAiChefLoading(false);
    }
  };

  const handleAddRecipeIngredients = (recipeId: string): void => {
    const recipe = recipes.find((entry) => entry.id === recipeId);
    if (!recipe) {
      return;
    }

    const items = recipeIngredientsToShoppingItems(recipe);
    setShoppingList((currentItems) => mergeShoppingItems(currentItems, items));
    setListOpen(true);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-top-row">
          <div className="header-copy">
            <p className="eyebrow">AIChef</p>
            <h1>Modern einkaufen mit klaren Angeboten</h1>
          </div>
          <div className="header-controls">
            <button
              type="button"
              className={`secondary-button header-list-button ${listOpen ? 'active' : ''}`}
              onClick={() => setListOpen((current) => !current)}
            >
              Liste
              {openShoppingCount > 0 ? (
                <span className="header-badge">{openShoppingCount}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`icon-button ${settingsOpen ? 'active' : ''}`}
              aria-label="Einstellungen"
              onClick={() => setSettingsOpen((current) => !current)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  d="M11.98 2a2 2 0 0 1 1.94 1.5l.3 1.18c.2.08.4.17.6.28l1.14-.44a2 2 0 0 1 2.44.87l1 1.73a2 2 0 0 1-.26 2.58l-.83.86c.03.21.05.43.05.64s-.02.43-.05.64l.83.86a2 2 0 0 1 .26 2.58l-1 1.73a2 2 0 0 1-2.44.87l-1.14-.44c-.2.11-.4.2-.6.28l-.3 1.18A2 2 0 0 1 11.98 22h-2a2 2 0 0 1-1.94-1.5l-.3-1.18a6.7 6.7 0 0 1-.6-.28L6 19.48a2 2 0 0 1-2.44-.87l-1-1.73a2 2 0 0 1 .26-2.58l.83-.86A5.6 5.6 0 0 1 3.6 12c0-.21.02-.43.05-.64l-.83-.86a2 2 0 0 1-.26-2.58l1-1.73A2 2 0 0 1 6 4.32l1.14.44c.2-.11.4-.2.6-.28l.3-1.18A2 2 0 0 1 9.98 2h2zm-1 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </div>
        </div>
        <p className="small-copy">
          Fokus zuerst auf Tab 1: Angebote vollstaendig laden, filtern und direkt speichern. Die Liste ist jetzt oben in der Kopfzeile.
        </p>
      </header>

      {settingsOpen ? (
        <section className="panel settings-panel">
          <div className="panel-header">
            <h3>Einstellungen</h3>
            <p className="small-copy">PLZ, Login und Darstellung verwalten.</p>
          </div>

          <div className="settings-grid">
            <label>
              PLZ
              <input
                type="text"
                maxLength={5}
                value={settingsPostalCode}
                onChange={(event) =>
                  setSettingsPostalCode(event.target.value.replace(/[^\d]/g, ''))
                }
              />
            </label>
            <button
              type="button"
              className="secondary-button settings-action-button"
              onClick={handleSavePostalCode}
            >
              PLZ speichern
            </button>
          </div>

          <div className="theme-row">
            <span className="small-copy">Theme</span>
            <div className="inline-controls">
              <button
                type="button"
                className={`mini-button ${uiSettings.theme === 'light' ? 'active' : ''}`}
                onClick={() => handleThemeChange('light')}
              >
                Light
              </button>
              <button
                type="button"
                className={`mini-button ${uiSettings.theme === 'dark' ? 'active' : ''}`}
                onClick={() => handleThemeChange('dark')}
              >
                Dark
              </button>
            </div>
          </div>

          <div className="settings-login">
            <h4>Login</h4>
            {uiSettings.isLoggedIn ? (
              <div className="settings-grid">
                <p className="small-copy">Eingeloggt als {uiSettings.loginEmail}</p>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleLogout}
                >
                  Logout
                </button>
              </div>
            ) : (
              <div className="settings-grid">
                <label>
                  E-Mail
                  <input
                    type="email"
                    value={loginEmailInput}
                    onChange={(event) => setLoginEmailInput(event.target.value)}
                  />
                </label>
                <label>
                  Passwort
                  <input
                    type="password"
                    value={loginPasswordInput}
                    onChange={(event) => setLoginPasswordInput(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button settings-action-button"
                  onClick={handleLogin}
                >
                  Login
                </button>
              </div>
            )}
          </div>

          {settingsInfo ? <p className="status">{settingsInfo}</p> : null}
        </section>
      ) : null}

      {listOpen ? (
        <ShoppingListSection
          items={shoppingList}
          onToggle={handleToggleShoppingItem}
          onUpdate={handleUpdateShoppingItem}
          onRemove={handleRemoveShoppingItem}
        />
      ) : null}

      <main className="screen-area">
        {activeTab === 'offers' ? (
          <OffersTab
            offers={offers}
            visibleOffers={filteredOffers}
            filters={offerFilters}
            locationFilter={locationFilter}
            ingestLoading={ingestLoading}
            ingestProgress={ingestProgress}
            ingestError={ingestError}
            ingestWarnings={ingestWarnings}
            onFiltersChange={setOfferFilters}
            onLocationFilterChange={setLocationFilter}
            onRequestGps={handleRequestGps}
            onRefreshOffers={handleRefreshOffers}
            onAddToShoppingList={handleAddOfferToShoppingList}
          />
        ) : null}

        {activeTab === 'aichef' ? (
          <AiChefTab
            offers={offers}
            recipes={recipes}
            preferences={preferences}
            loading={aiChefLoading}
            error={aiChefError}
            warnings={aiChefWarnings}
            onPreferencesChange={setPreferences}
            onGenerateRecipes={handleGenerateRecipes}
            onAddRecipeIngredients={handleAddRecipeIngredients}
          />
        ) : null}

        {activeTab === 'later' ? (
          <div className="tab-layout">
            <section className="hero-panel">
              <p className="eyebrow">Tab 3</p>
              <h2>Spaeter</h2>
              <p className="small-copy">
                Dieser Bereich ist als Platzhalter fuer eine spaetere Funktion reserviert.
              </p>
            </section>
          </div>
        ) : null}
      </main>

      <TabNav activeTab={activeTab} onChange={setActiveTab} />
    </div>
  );
}
