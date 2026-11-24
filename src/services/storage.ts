const OFFER_STORAGE_KEY = 'aichef.offers.v1';
const SHOPPING_LIST_STORAGE_KEY = 'aichef.shoppingList.v1';
const USER_PREFERENCES_STORAGE_KEY = 'aichef.userPreferences.v1';
const RECIPES_STORAGE_KEY = 'aichef.recipes.v1';
const LOCATION_STORAGE_KEY = 'aichef.location.v1';
const UI_SETTINGS_STORAGE_KEY = 'aichef.uiSettings.v1';

export const storageKeys = {
  offers: OFFER_STORAGE_KEY,
  shoppingList: SHOPPING_LIST_STORAGE_KEY,
  userPreferences: USER_PREFERENCES_STORAGE_KEY,
  recipes: RECIPES_STORAGE_KEY,
  location: LOCATION_STORAGE_KEY,
  uiSettings: UI_SETTINGS_STORAGE_KEY,
};

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readJson<T>(key: string, fallback: T): T {
  if (!hasWindow()) {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson<T>(key: string, value: T): void {
  if (!hasWindow()) {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota or serialization errors to keep UI responsive.
  }
}
