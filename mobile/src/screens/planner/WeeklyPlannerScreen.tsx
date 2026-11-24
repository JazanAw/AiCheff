import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, fontFamilies, spacing, radius } from '../../theme';
import { useSubscription } from '../../store/SubscriptionContext';
import { usePreferences } from '../../store/PreferencesContext';
import { LockedFeature } from '../../components/common/LockedFeature';
import { Icon } from '../../components/common/Icon';
import { HeaderActions } from '../../components/common/HeaderActions';
import { RecipeIllustration } from '../../components/common/RecipeIllustration';
import { MealCategory, MealType, PantryItem, Recipe, WeeklyPlanEntry } from '../../types';
import { logRecipeAsMeal } from '../../services/dietTrackingApi';
import { fetchPantryItems } from '../../services/pantryApi';
import {
  CUISINE_FILTER_CANDIDATES,
  CUISINE_SLUGS,
  normalizeCuisine,
  type CuisineSlug,
} from '../../utils/cuisine';
import {
  buildWeeklyOfferPlan,
  pickDinnerDays,
  type OfferPlanSuggestion,
} from '../../utils/weeklyOfferPlanner';
import { OfferWeekPlannerSheet, type OfferPlanOptions } from './components/OfferWeekPlannerSheet';
import {
  OfferSuggestionsSheet,
  type DaySuggestion,
  type OfferPlanPhase,
} from './components/OfferSuggestionsSheet';
import {
  fetchPlannerEntries,
  removePlannerEntry,
  todayDayOfWeek,
  upsertPlannerEntry,
  weekStartDate,
} from '../../services/plannerApi';
import { fetchUserRecipeState, recordSwipe } from '../../services/swipesApi';
import { fetchRecipes } from '../../services/recipesApi';
import { planRecipeToWeek } from '../../services/planRecipeFlow';
import {
  fetchCookedEntryIds,
  markEntryCooked,
  unmarkEntryCooked,
} from '../../services/cookLogApi';
import {
  addWeeks,
  getISOWeekNumber,
  isDayPlannable,
  weekRelation,
} from '../../utils/weekDate';
import { floatingTabBarClearance } from '../../navigation/components/FloatingGlassTabBar';
import { RecipeDetailScreen } from '../cheffity/RecipeDetailScreen';
import { PlanRecipeSheet } from '../cheffity/components/PlanRecipeSheet';
import type { PlanRecipeChoice } from '../cheffity/components/PlanRecipeSheet';
import { PlannedEntrySheet } from './components/PlannedEntrySheet';
import { RecipePickerSheet } from './components/RecipePickerSheet';
import { WeeklyShoppingListSheet } from './components/WeeklyShoppingListSheet';
import {
  commitWeeklyShoppingItems,
  loadWeeklyShoppingPreview,
  type WeeklyShoppingPreview,
} from '../../services/weeklyShoppingFlow';

const DAY_KEYS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;

// Includes `sweet_baked` so recipes planned as "Snack" from the Cheffity plan
// sheet are visible here too (the enum has no dedicated 'snack' value).
const MEAL_TYPES_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'sweet_baked'];

function formatWeekRange(weekStart: Date, locale: string): string {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  const fmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' });
  const startStr = fmt.format(weekStart).replace('.', '');
  const endStr = fmt.format(end).replace('.', '');
  return `${startStr} – ${endStr}`;
}

export function WeeklyPlannerScreen() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { hasFeature, requiredTier } = useSubscription();
  const { preferences } = usePreferences();
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState<WeeklyPlanEntry[]>([]);
  const [selectedDay, setSelectedDay] = useState(todayDayOfWeek());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  // Cooked weekly_plan_entry ids for the visible week (cooked = has a row).
  const [cookedEntryIds, setCookedEntryIds] = useState<Set<string>>(new Set());
  // ISO Monday string of the visible week. Navigation moves this; the load
  // effect refetches whenever it changes. Defaults to the current week.
  const [visibleWeekStart, setVisibleWeekStart] = useState<string>(() => weekStartDate());
  // The tapped entry → action sheet; the entry being edited → PlanRecipeSheet;
  // the recipe being viewed → RecipeDetailScreen modal.
  const [selectedEntry, setSelectedEntry] = useState<WeeklyPlanEntry | null>(null);
  const [editingEntry, setEditingEntry] = useState<WeeklyPlanEntry | null>(null);
  const [viewingRecipe, setViewingRecipe] = useState<Recipe | null>(null);
  // Empty-slot add flow: the tapped slot opens the recipe picker; picking a
  // recipe opens PlanRecipeSheet (create) with that slot preselected.
  const [addSlot, setAddSlot] = useState<{ dayOfWeek: number; mealType: MealType } | null>(null);
  const [pendingCreate, setPendingCreate] = useState<
    { recipe: Recipe; dayOfWeek: number; mealType: MealType } | null
  >(null);
  const [allRecipes, setAllRecipes] = useState<Recipe[]>([]);
  const [recipesLoading, setRecipesLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Weekly shopping-list review sheet.
  const [shoppingOpen, setShoppingOpen] = useState(false);
  const [shoppingPreview, setShoppingPreview] = useState<WeeklyShoppingPreview | null>(null);
  const [shoppingLoading, setShoppingLoading] = useState(false);
  const [shoppingSubmitting, setShoppingSubmitting] = useState(false);
  // "Woche mit Angeboten planen" flow.
  const [offerPantry, setOfferPantry] = useState<PantryItem[]>([]);
  const [offerOptionsOpen, setOfferOptionsOpen] = useState(false);
  const [offerSheetOpen, setOfferSheetOpen] = useState(false);
  const [offerPhase, setOfferPhase] = useState<OfferPlanPhase>('list');
  const [offerSuggestions, setOfferSuggestions] = useState<DaySuggestion[]>([]);
  const [offerEmptyReason, setOfferEmptyReason] = useState<'no_offers' | 'too_few' | null>(null);
  const [offerLimited, setOfferLimited] = useState(false);
  // Ranked alternates (beyond the shown set) used by "Ersetzen".
  const [offerPool, setOfferPool] = useState<OfferPlanSuggestion[]>([]);
  const [offerSubmitting, setOfferSubmitting] = useState(false);
  const [offerPlannedCount, setOfferPlannedCount] = useState(0);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  const weekStartDateStr = visibleWeekStart;
  const weekStartDateObj = useMemo(() => new Date(`${weekStartDateStr}T00:00:00`), [weekStartDateStr]);
  const weekNumber = useMemo(() => getISOWeekNumber(weekStartDateObj), [weekStartDateObj]);
  const weekRange = useMemo(
    () => formatWeekRange(weekStartDateObj, i18n.language || 'de'),
    [weekStartDateObj, i18n.language],
  );
  // past / current / future relative to the real "now".
  const relation = useMemo(() => weekRelation(weekStartDateObj), [weekStartDateObj]);
  const isCurrentWeek = relation === 'current';
  const isPastWeek = relation === 'past';
  const dayPlannable = useCallback(
    (dayOfWeek: number) => isDayPlannable(relation, dayOfWeek, todayDayOfWeek()),
    [relation],
  );

  const load = useCallback(async () => {
    try {
      const rows = await fetchPlannerEntries(weekStartDateStr);
      setEntries(rows);
      setError(null);
      // Cook-status for this week's entries (best-effort).
      try {
        const cooked = await fetchCookedEntryIds(rows.map((r) => r.id));
        setCookedEntryIds(cooked);
      } catch {
        setCookedEntryIds(new Set());
      }
    } catch (e) {
      setError((e as Error).message);
    }
    // Favorite state powers the heart in the recipe detail opened from here.
    // Best-effort: a failure must not block the plan from rendering.
    try {
      const state = await fetchUserRecipeState();
      setFavoriteIds(state.favoriteIds);
    } catch {
      /* keep previous favorites */
    }
  }, [weekStartDateStr]);

  useEffect(() => {
    if (!hasFeature('weekly_planner')) {
      setLoading(false);
      return;
    }
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [hasFeature, load]);

  // Reload whenever the planner regains focus so a recipe planned from the
  // Cheffity tab (swipe / details / lists) shows up without a manual refresh.
  useFocusEffect(
    useCallback(() => {
      if (!hasFeature('weekly_planner')) return;
      load();
    }, [hasFeature, load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // ── Week navigation ──
  const navigateWeek = (offset: number) => {
    const next = weekStartDate(addWeeks(weekStartDateObj, offset));
    setVisibleWeekStart(next);
    const nextRelation = weekRelation(new Date(`${next}T00:00:00`));
    setSelectedDay(nextRelation === 'current' ? todayDayOfWeek() : 0);
  };
  const goToCurrentWeek = () => {
    setVisibleWeekStart(weekStartDate());
    setSelectedDay(todayDayOfWeek());
  };

  // ── Cook status toggle (works in any week, incl. past) ──
  const handleToggleCooked = () => {
    const entry = selectedEntry;
    if (!entry) return;
    const wasCooked = cookedEntryIds.has(entry.id);
    // Optimistic — the sheet stays open so the badge flips live.
    setCookedEntryIds((prev) => {
      const next = new Set(prev);
      if (wasCooked) next.delete(entry.id);
      else next.add(entry.id);
      return next;
    });
    const op = wasCooked
      ? unmarkEntryCooked(entry.id)
      : markEntryCooked({ recipeId: entry.recipeId, weeklyPlanEntryId: entry.id });
    op
      .then(() =>
        setToast(
          wasCooked
            ? t('planner.entrySheet.notCookedToast')
            : t('planner.entrySheet.cookedToast'),
        ),
      )
      .catch((e) => {
        // Revert on failure.
        setCookedEntryIds((prev) => {
          const next = new Set(prev);
          if (wasCooked) next.add(entry.id);
          else next.delete(entry.id);
          return next;
        });
        Alert.alert(t('common.error'), (e as Error).message);
      });
  };

  const handleRemoveEntry = (entry: WeeklyPlanEntry) => {
    Alert.alert(
      t('planner.removeTitle'),
      entry.recipe.name,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            const previous = entries;
            setEntries((prev) => prev.filter((e) => e.id !== entry.id));
            try {
              await removePlannerEntry(entry.id);
            } catch (e) {
              setEntries(previous);
              Alert.alert(t('common.error'), (e as Error).message);
            }
          },
        },
      ],
    );
  };

  // ── Action sheet wiring ──
  const handleViewRecipe = () => {
    const recipe = selectedEntry?.recipe ?? null;
    setSelectedEntry(null);
    if (recipe) setViewingRecipe(recipe);
  };

  const handleEditPlan = () => {
    const entry = selectedEntry;
    setSelectedEntry(null);
    if (entry) setEditingEntry(entry);
  };

  const handleRemoveFromSheet = () => {
    const entry = selectedEntry;
    setSelectedEntry(null);
    if (entry) handleRemoveEntry(entry);
  };

  // Log the planned recipe (× portions) as eaten today in the tracker. This is
  // distinct from "cooked": cooked stays a cooking signal, this feeds nutrition.
  const handleLogToTracking = () => {
    const entry = selectedEntry;
    setSelectedEntry(null);
    if (!entry) return;
    const portions = entry.portionOverride ?? entry.recipe.servings;
    const category: MealCategory =
      entry.mealType === 'breakfast' || entry.mealType === 'lunch' || entry.mealType === 'dinner'
        ? entry.mealType
        : 'snack';
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const n = entry.recipe.nutritionPerServing;
    logRecipeAsMeal({
      date: today,
      category,
      recipeId: entry.recipeId,
      recipeName: entry.recipe.name,
      portions,
      caloriesPerServing: n?.calories,
      proteinPerServing: n?.protein,
      carbsPerServing: n?.carbs,
      fatPerServing: n?.fat,
    })
      .then(() => setToast(t('diet.loggedToTracking')))
      .catch((e) => Alert.alert(t('common.error'), (e as Error).message));
  };

  // ── Empty-slot add flow ──
  const ensureRecipesLoaded = useCallback(async () => {
    if (allRecipes.length > 0 || recipesLoading) return;
    setRecipesLoading(true);
    try {
      const rows = await fetchRecipes({ limit: 200, preferences });
      setAllRecipes(rows);
    } catch (e) {
      console.warn('[WeeklyPlannerScreen] fetchRecipes failed:', (e as Error).message);
    } finally {
      setRecipesLoading(false);
    }
  }, [allRecipes.length, recipesLoading, preferences]);

  const handleOpenAddSlot = (dayOfWeek: number, mealType: MealType) => {
    if (!dayPlannable(dayOfWeek)) return; // past day/week → not plannable
    setAddSlot({ dayOfWeek, mealType });
    ensureRecipesLoaded();
  };

  const handlePickRecipe = (recipe: Recipe) => {
    const slot = addSlot;
    setAddSlot(null);
    if (slot) setPendingCreate({ recipe, dayOfWeek: slot.dayOfWeek, mealType: slot.mealType });
  };

  // Warn before replacing a different recipe already planned in the target
  // slot. `sourceId` is the entry being edited (skip the warning for the same
  // entry / same slot). `proceed` runs only after confirmation.
  const withOverwriteGuard = (
    choice: PlanRecipeChoice,
    sourceId: string | null,
    proceed: () => void,
  ) => {
    const target = entries.find(
      (e) => e.dayOfWeek === choice.dayOfWeek && e.mealType === choice.mealType,
    );
    if (target && target.id !== sourceId) {
      Alert.alert(
        t('planner.overwriteTitle'),
        t('planner.overwriteMessage', { name: target.recipe.name }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('planner.overwriteConfirm'), style: 'destructive', onPress: proceed },
        ],
      );
    } else {
      proceed();
    }
  };

  // Create from an empty slot. Reuses planRecipeToWeek (upsert + optional
  // shopping). Overwrite is guarded in case the user changed the slot in the
  // sheet to one that is already occupied.
  const handleCreateConfirm = (choice: PlanRecipeChoice) => {
    const pc = pendingCreate;
    setPendingCreate(null);
    if (!pc) return;
    withOverwriteGuard(choice, null, async () => {
      try {
        await planRecipeToWeek({
          recipe: pc.recipe,
          dayOfWeek: choice.dayOfWeek,
          mealType: choice.mealType,
          portions: choice.portions,
          defaultPortionSize: preferences.defaultPortionSize,
          addMissingToShopping: choice.addMissingToShopping,
          weekStart: weekStartDateStr,
        });
        setSelectedDay(choice.dayOfWeek);
        setToast(t('cheffity.toastAdded'));
        await load();
      } catch (e) {
        Alert.alert(t('common.error'), (e as Error).message);
        await load();
      }
    });
  };

  // Persist a plan change from the edit sheet. If the slot (day/meal) moved we
  // delete the old row first, then upsert the new slot — the unique key is
  // (user, week, day, meal). Portions become an override vs. the user default.
  const handleEditConfirm = (choice: PlanRecipeChoice) => {
    const entry = editingEntry;
    setEditingEntry(null);
    if (!entry) return;
    withOverwriteGuard(choice, entry.id, async () => {
      const slotChanged =
        choice.dayOfWeek !== entry.dayOfWeek || choice.mealType !== entry.mealType;
      const portionOverride =
        choice.portions !== preferences.defaultPortionSize ? choice.portions : undefined;
      try {
        if (slotChanged) {
          await removePlannerEntry(entry.id);
        }
        await upsertPlannerEntry({
          dayOfWeek: choice.dayOfWeek,
          mealType: choice.mealType,
          recipeId: entry.recipeId,
          portionOverride,
          weekStart: weekStartDateStr,
        });
        setSelectedDay(choice.dayOfWeek);
        await load();
      } catch (e) {
        Alert.alert(t('common.error'), (e as Error).message);
        await load();
      }
    });
  };

  const handleToggleFavorite = (recipe: Recipe) => {
    const wasFavorite = favoriteIds.has(recipe.id);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (wasFavorite) next.delete(recipe.id);
      else next.add(recipe.id);
      return next;
    });
    recordSwipe(recipe.id, wasFavorite ? 'unfavorite' : 'favorite').catch((e) =>
      console.warn('[WeeklyPlannerScreen] recordSwipe(favorite) failed:', (e as Error).message),
    );
  };

  // ── Weekly shopping list ──
  const handleCreateShoppingList = () => {
    if (entries.length === 0) {
      setToast(t('planner.weeklyShopping.noRecipes'));
      return;
    }
    setShoppingOpen(true);
    setShoppingPreview(null);
    setShoppingLoading(true);
    loadWeeklyShoppingPreview(entries)
      .then(setShoppingPreview)
      .catch((e) => {
        console.warn('[WeeklyPlannerScreen] loadWeeklyShoppingPreview failed:', (e as Error).message);
        setShoppingOpen(false);
        Alert.alert(t('common.error'), (e as Error).message);
      })
      .finally(() => setShoppingLoading(false));
  };

  const handleConfirmShoppingList = () => {
    const preview = shoppingPreview;
    if (!preview || preview.items.length === 0) {
      setShoppingOpen(false);
      return;
    }
    setShoppingSubmitting(true);
    commitWeeklyShoppingItems(preview.items)
      .then((count) => {
        setShoppingOpen(false);
        setToast(t('planner.weeklyShopping.added', { count }));
      })
      .catch((e) => Alert.alert(t('common.error'), (e as Error).message))
      .finally(() => setShoppingSubmitting(false));
  };

  // ── Woche mit Angeboten planen ──
  // Cuisine chips for the options sheet: only the cuisines actually present in
  // the loaded recipes (curated order first, then any extras) — no dead chips.
  const offerCuisineOptions = useMemo<CuisineSlug[]>(() => {
    const present = new Set(allRecipes.map((r) => normalizeCuisine(r.cuisine)));
    const fromCandidates = CUISINE_FILTER_CANDIDATES.filter((slug) => present.has(slug));
    const extras = CUISINE_SLUGS.filter(
      (slug) => present.has(slug) && !CUISINE_FILTER_CANDIDATES.includes(slug),
    );
    return [...fromCandidates, ...extras];
  }, [allRecipes]);

  // Load recipes + pantry and RETURN them (state updates are async, so the
  // generate step can't read them back from state in the same tick).
  const ensurePlanningData = useCallback(async (): Promise<{
    recipes: Recipe[];
    pantry: PantryItem[];
  }> => {
    let recipes = allRecipes;
    if (recipes.length === 0) {
      try {
        recipes = await fetchRecipes({ limit: 200, preferences });
        setAllRecipes(recipes);
      } catch (e) {
        console.warn('[WeeklyPlannerScreen] fetchRecipes failed:', (e as Error).message);
        recipes = [];
      }
    }
    let pantry = offerPantry;
    if (pantry.length === 0) {
      try {
        pantry = await fetchPantryItems();
        setOfferPantry(pantry);
      } catch (e) {
        console.warn('[WeeklyPlannerScreen] fetchPantryItems failed:', (e as Error).message);
        pantry = [];
      }
    }
    return { recipes, pantry };
  }, [allRecipes, offerPantry, preferences]);

  const handleOpenOfferPlan = () => {
    setOfferOptionsOpen(true);
    // Warm the cuisine chips; the sheet renders immediately and updates when ready.
    ensurePlanningData();
  };

  const handleGenerateSuggestions = async (options: OfferPlanOptions) => {
    const { recipes, pantry } = await ensurePlanningData();
    setOfferOptionsOpen(false);
    setOfferPhase('list');

    const plannedRecipeIds = new Set(entries.map((e) => e.recipeId));
    const result = buildWeeklyOfferPlan({
      recipes,
      pantryItems: pantry,
      count: 99, // full ordered list; sliced for display, the rest are alternates
      cuisine: options.cuisine,
      usePantry: options.usePantry,
      preferDeals: options.preferDeals,
      quickOnly: options.quickOnly,
      plannedRecipeIds,
    });

    if (!result.ok) {
      setOfferSuggestions([]);
      setOfferEmptyReason(result.reason);
      setOfferPool([]);
      setOfferLimited(false);
      setOfferSheetOpen(true);
      return;
    }

    // Pair the best suggestions with free dinner slots (1/day, forward from the
    // start day; current week starts today, future weeks start Monday).
    const occupiedDinnerDays = new Set(
      entries.filter((e) => e.mealType === 'dinner').map((e) => e.dayOfWeek),
    );
    const startDay = relation === 'current' ? todayDayOfWeek() : 0;
    const days = pickDinnerDays(options.count, occupiedDinnerDays, startDay);
    const take = Math.min(days.length, result.suggestions.length);

    const shown: DaySuggestion[] = result.suggestions.slice(0, take).map((s, i) => ({
      dayOfWeek: days[i],
      recipe: s.recipe,
      offer: s.offer,
      reasons: s.reasons,
    }));

    setOfferSuggestions(shown);
    setOfferPool(result.suggestions.slice(take));
    setOfferEmptyReason(shown.length === 0 ? 'too_few' : null);
    setOfferLimited(take > 0 && take < options.count);
    setOfferSheetOpen(true);
  };

  const handleReplaceSuggestion = (index: number) => {
    const usedIds = new Set(offerSuggestions.map((s) => s.recipe.id));
    const altIndex = offerPool.findIndex((p) => !usedIds.has(p.recipe.id));
    if (altIndex === -1) {
      setToast(t('planner.offerPlan.noAlternative'));
      return;
    }
    const alt = offerPool[altIndex];
    setOfferSuggestions((current) => {
      const next = [...current];
      next[index] = {
        dayOfWeek: current[index].dayOfWeek,
        recipe: alt.recipe,
        offer: alt.offer,
        reasons: alt.reasons,
      };
      return next;
    });
    setOfferPool((pool) => pool.filter((_, i) => i !== altIndex));
  };

  const handleAcceptSuggestions = async () => {
    if (offerSuggestions.length === 0) return;
    setOfferSubmitting(true);
    // Distinct (day, dinner) slots → independent upserts; one failure must not
    // abort the rest. Missing ingredients are intentionally NOT added here — the
    // weekly shopping sheet (opened from the success CTA) handles that, deduped.
    const results = await Promise.all(
      offerSuggestions.map(async (s) => {
        try {
          await planRecipeToWeek({
            recipe: s.recipe,
            dayOfWeek: s.dayOfWeek,
            mealType: 'dinner',
            portions: preferences.defaultPortionSize,
            defaultPortionSize: preferences.defaultPortionSize,
            addMissingToShopping: false,
            pantryItems: offerPantry,
            weekStart: weekStartDateStr,
          });
          return true;
        } catch (e) {
          console.warn('[WeeklyPlannerScreen] planRecipeToWeek failed:', (e as Error).message);
          return false;
        }
      }),
    );
    setOfferSubmitting(false);
    const planned = results.filter(Boolean).length;
    await load();
    if (planned === 0) {
      setOfferPhase('error');
      return;
    }
    setOfferPlannedCount(planned);
    setOfferPhase('success');
  };

  // Success CTA → reuse the existing weekly shopping preview/sheet.
  const handleOfferCheckShopping = () => {
    setOfferSheetOpen(false);
    handleCreateShoppingList();
  };

  if (!hasFeature('weekly_planner')) {
    return (
      <LockedFeature requiredTier={requiredTier('weekly_planner')}>
        <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
          <Text style={[styles.title, { color: colors.text, padding: spacing.lg }]}>
            {t('planner.title')}
          </Text>
        </SafeAreaView>
      </LockedFeature>
    );
  }

  const today = todayDayOfWeek();
  const dayEntries = entries.filter((e) => e.dayOfWeek === selectedDay);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>{t('planner.title')}</Text>
        <HeaderActions />
      </View>

      {/* Week navigation: prev / KW + range + status / next */}
      <View style={styles.weekNav}>
        <Pressable
          onPress={() => navigateWeek(-1)}
          style={[styles.navBtn, { backgroundColor: colors.surface }]}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t('planner.prevWeek')}
        >
          <Icon name="arrow-left" size={18} color={colors.text} />
        </Pressable>

        <View style={styles.weekNavCenter}>
          <Text style={[styles.weekNavKw, { color: colors.text }]} numberOfLines={1}>
            {t('planner.weekEyebrow', { week: weekNumber, range: weekRange })}
          </Text>
          <Text
            style={[
              styles.weekStatus,
              {
                color: isPastWeek
                  ? colors.textTertiary
                  : isCurrentWeek
                    ? colors.accent
                    : colors.primary,
              },
            ]}
          >
            {isPastWeek
              ? t('planner.status.past')
              : isCurrentWeek
                ? t('planner.status.current')
                : t('planner.status.future')}
          </Text>
        </View>

        <Pressable
          onPress={() => navigateWeek(1)}
          style={[styles.navBtn, { backgroundColor: colors.surface }]}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t('planner.nextWeek')}
        >
          <Icon name="chevron-right" size={20} color={colors.text} />
        </Pressable>
      </View>

      {!isCurrentWeek && (
        <Pressable
          onPress={goToCurrentWeek}
          style={[styles.todayButton, { borderColor: colors.primary }]}
          accessibilityRole="button"
        >
          <Text style={[styles.todayButtonText, { color: colors.primary }]}>
            {t('planner.backToCurrent')}
          </Text>
        </Pressable>
      )}

      {error && (
        <View style={[styles.errorBar, { backgroundColor: colors.errorLight, borderColor: colors.error }]}>
          <Text style={[typography.bodySmall, { color: colors.error }]}>{error}</Text>
        </View>
      )}

      {/* Day chips */}
      <View style={styles.daySelector}>
        {DAY_KEYS.map((key, index) => {
          const isActive = selectedDay === index;
          const isToday = isCurrentWeek && index === today;
          const hasMeals = entries.some((e) => e.dayOfWeek === index);
          const date = new Date(weekStartDateObj);
          date.setDate(date.getDate() + index);
          return (
            <Pressable
              key={key}
              style={[
                styles.dayChip,
                {
                  backgroundColor: isActive ? colors.primary : isToday ? colors.primaryLight : colors.surface,
                },
              ]}
              onPress={() => setSelectedDay(index)}
            >
              <Text
                style={[
                  styles.dayLabel,
                  { color: isActive ? '#FFFFFF' : isToday ? colors.primary : colors.textSecondary },
                ]}
              >
                {t(`planner.daysShort.${key}`)}
              </Text>
              <Text
                style={[
                  styles.dayNumber,
                  { color: isActive ? '#FFFFFF' : colors.text },
                ]}
              >
                {date.getDate()}
              </Text>
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor: hasMeals
                      ? isActive
                        ? '#FFFFFF'
                        : colors.primary
                      : 'transparent',
                  },
                ]}
              />
            </Pressable>
          );
        })}
      </View>

      {/* Calm "plan the week from offers" entry point. Hidden for past weeks. */}
      {!isPastWeek && (
        <Pressable
          style={({ pressed }) => [
            styles.offerPlanButton,
            { backgroundColor: colors.primaryLight, borderColor: colors.primary + '33', opacity: pressed ? 0.9 : 1 },
          ]}
          onPress={handleOpenOfferPlan}
          accessibilityRole="button"
          accessibilityLabel={t('planner.offerPlan.button')}
        >
          <View style={[styles.offerPlanIcon, { backgroundColor: colors.primary }]}>
            <Icon name="sparkle" size={20} color="#FFFFFF" active />
          </View>
          <View style={styles.offerPlanTextWrap}>
            <Text style={[styles.offerPlanTitle, { color: colors.text }]} numberOfLines={1}>
              {t('planner.offerPlan.button')}
            </Text>
            <Text style={[styles.offerPlanSub, { color: colors.textSecondary }]} numberOfLines={1}>
              {t('planner.offerPlan.buttonSub')}
            </Text>
          </View>
          <Icon name="chevron-right" size={20} color={colors.primary} />
        </Pressable>
      )}

      {/* Week-level action: create the shopping list for all planned recipes.
          Hidden for past weeks (nothing left to shop for). */}
      {!isPastWeek && (
        <Pressable
          style={({ pressed }) => [
            styles.shoppingButton,
            { backgroundColor: colors.accent, opacity: pressed ? 0.85 : 1 },
          ]}
          onPress={handleCreateShoppingList}
          accessibilityRole="button"
          accessibilityLabel={t('planner.weeklyShopping.button')}
        >
          <Icon name="cart-plus" size={18} color="#FFFFFF" />
          <Text style={styles.shoppingButtonText}>{t('planner.weeklyShopping.button')}</Text>
        </Pressable>
      )}

      {/* Meal cards */}
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: floatingTabBarClearance(insets.bottom) }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        <Text style={[styles.dayTitle, { color: colors.textSecondary }]}>
          {t(`planner.days.${DAY_KEYS[selectedDay]}`)}
        </Text>

        {MEAL_TYPES_ORDER.map((mealType) => {
          const meal = dayEntries.find((e) => e.mealType === mealType);
          const mealLabel = t(`cheffity.mealTypes.${mealType}`);

          const slotPlannable = dayPlannable(selectedDay);

          if (!meal) {
            // Non-plannable (past day/week) → neutral, non-interactive placeholder.
            if (!slotPlannable) {
              return (
                <View
                  key={mealType}
                  style={[styles.emptyRow, styles.emptyRowMuted, { borderColor: colors.borderLight }]}
                >
                  <Text style={[styles.emptyEyebrow, { color: colors.textTertiary }]}>
                    {mealLabel}
                  </Text>
                  <Text style={[styles.emptyText, { color: colors.textTertiary }]} numberOfLines={1}>
                    {isPastWeek ? t('planner.pastSlot') : t('planner.emptySlot')}
                  </Text>
                </View>
              );
            }
            // Tappable, compact "add recipe" slot → opens the recipe picker.
            return (
              <Pressable
                key={mealType}
                style={({ pressed }) => [
                  styles.emptyRow,
                  { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                ]}
                onPress={() => handleOpenAddSlot(selectedDay, mealType)}
                accessibilityRole="button"
                accessibilityLabel={`${mealLabel}: ${t('planner.addToSlot')}`}
              >
                <Text style={[styles.emptyEyebrow, { color: colors.textTertiary }]}>
                  {mealLabel}
                </Text>
                <Text style={[styles.emptyText, { color: colors.primary }]} numberOfLines={1}>
                  {t('planner.addToSlot')}
                </Text>
                <Icon name="plus" size={18} color={colors.primary} />
              </Pressable>
            );
          }

          const portions = meal.portionOverride ?? meal.recipe.servings;
          const kcal = meal.recipe.nutritionPerServing?.calories;
          const isCooked = cookedEntryIds.has(meal.id);
          return (
            <Pressable
              key={mealType}
              style={({ pressed }) => [
                styles.entryCard,
                {
                  backgroundColor: colors.surfaceElevated,
                  borderColor: colors.border,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
              onPress={() => setSelectedEntry(meal)}
              accessibilityRole="button"
              accessibilityLabel={`${mealLabel}: ${meal.recipe.name}`}
            >
              <View style={[styles.entryAccent, { backgroundColor: colors.primary }]} />
              <View style={styles.entryThumb}>
                <RecipeIllustration recipeId={meal.recipe.id} />
              </View>
              <View style={styles.entryBody}>
                <Text style={[styles.entryEyebrow, { color: colors.textTertiary }]}>
                  {mealLabel}
                </Text>
                <Text style={[styles.entryName, { color: colors.text }]} numberOfLines={2}>
                  {meal.recipe.name}
                </Text>
                <View style={styles.entryMetaRow}>
                  <View style={styles.entryMetaItem}>
                    <Icon name="clock" size={11} color={colors.textSecondary} />
                    <Text style={[styles.entryMeta, { color: colors.textSecondary }]}>
                      {t('cheffity.cookTime', { minutes: meal.recipe.cookTimeMinutes })}
                    </Text>
                  </View>
                  <View style={styles.entryMetaItem}>
                    <Icon name="profile" size={11} color={colors.textSecondary} />
                    <Text style={[styles.entryMeta, { color: colors.textSecondary }]}>
                      {t('planner.entrySheet.portions', { count: portions })}
                    </Text>
                  </View>
                  {kcal ? (
                    <View style={styles.entryMetaItem}>
                      <Icon name="flame" size={11} color={colors.textSecondary} />
                      <Text style={[styles.entryMeta, { color: colors.textSecondary }]}>
                        {Math.round(kcal)} kcal
                      </Text>
                    </View>
                  ) : null}
                  {isCooked ? (
                    <View style={[styles.cookedBadge, { backgroundColor: colors.accentLight }]}>
                      <Icon name="check" size={10} color={colors.accent} strokeWidth={3} />
                      <Text style={[styles.cookedBadgeText, { color: colors.accent }]}>
                        {t('planner.entrySheet.cookedBadge')}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
              <View style={styles.entryChevron}>
                <Icon name="chevron-right" size={18} color={colors.textTertiary} />
              </View>
            </Pressable>
          );
        })}

        {loading && entries.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>
              {t('common.loading')}
            </Text>
          </View>
        )}

        {!loading && entries.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>
              {t('planner.empty')}
            </Text>
          </View>
        )}
      </ScrollView>

      <PlannedEntrySheet
        visible={selectedEntry != null}
        entry={selectedEntry}
        isCooked={selectedEntry ? cookedEntryIds.has(selectedEntry.id) : false}
        canModify={selectedEntry ? dayPlannable(selectedEntry.dayOfWeek) : false}
        colors={colors}
        t={t}
        onClose={() => setSelectedEntry(null)}
        onViewRecipe={handleViewRecipe}
        onEditPlan={handleEditPlan}
        onRemove={handleRemoveFromSheet}
        onToggleCooked={handleToggleCooked}
        onLogToTracking={handleLogToTracking}
        trackingEnabled={hasFeature('diet_tracking')}
      />

      <PlanRecipeSheet
        visible={editingEntry != null}
        recipe={editingEntry?.recipe ?? null}
        defaultPortions={preferences.defaultPortionSize}
        colors={colors}
        t={t}
        mode="edit"
        initialDayOfWeek={editingEntry?.dayOfWeek}
        initialMealType={editingEntry?.mealType}
        initialPortions={
          editingEntry
            ? editingEntry.portionOverride ?? preferences.defaultPortionSize
            : undefined
        }
        onCancel={() => setEditingEntry(null)}
        onConfirm={handleEditConfirm}
      />

      <RecipeDetailScreen
        recipes={viewingRecipe ? [viewingRecipe] : []}
        index={viewingRecipe ? 0 : null}
        isFavorite={(id) => favoriteIds.has(id)}
        onClose={() => setViewingRecipe(null)}
        onIndexChange={() => {}}
        onToggleFavorite={handleToggleFavorite}
      />

      <RecipePickerSheet
        visible={addSlot != null}
        recipes={allRecipes}
        loading={recipesLoading}
        colors={colors}
        t={t}
        onClose={() => setAddSlot(null)}
        onSelect={handlePickRecipe}
      />

      <PlanRecipeSheet
        visible={pendingCreate != null}
        recipe={pendingCreate?.recipe ?? null}
        defaultPortions={preferences.defaultPortionSize}
        colors={colors}
        t={t}
        initialDayOfWeek={pendingCreate?.dayOfWeek}
        initialMealType={pendingCreate?.mealType}
        onCancel={() => setPendingCreate(null)}
        onConfirm={handleCreateConfirm}
      />

      <WeeklyShoppingListSheet
        visible={shoppingOpen}
        weekLabel={`${t('planner.kwShort', { week: weekNumber })}`}
        preview={shoppingPreview}
        loading={shoppingLoading}
        submitting={shoppingSubmitting}
        colors={colors}
        t={t}
        onClose={() => setShoppingOpen(false)}
        onConfirm={handleConfirmShoppingList}
      />

      <OfferWeekPlannerSheet
        visible={offerOptionsOpen}
        cuisineOptions={offerCuisineOptions}
        colors={colors}
        t={t}
        onClose={() => setOfferOptionsOpen(false)}
        onGenerate={handleGenerateSuggestions}
      />

      <OfferSuggestionsSheet
        visible={offerSheetOpen}
        phase={offerPhase}
        weekNumber={weekNumber}
        suggestions={offerSuggestions}
        emptyReason={offerEmptyReason}
        limitedBySlots={offerLimited}
        submitting={offerSubmitting}
        plannedCount={offerPlannedCount}
        colors={colors}
        t={t}
        onClose={() => setOfferSheetOpen(false)}
        onReplace={handleReplaceSuggestion}
        onAccept={handleAcceptSuggestions}
        onCheckShopping={handleOfferCheckShopping}
      />

      {toast && (
        <View
          pointerEvents="none"
          style={[
            styles.toast,
            { backgroundColor: colors.accent, bottom: floatingTabBarClearance(insets.bottom) },
          ]}
        >
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -0.5,
  },
  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: 20,
    paddingTop: spacing.xs,
  },
  navBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekNavCenter: { flex: 1, alignItems: 'center' },
  weekNavKw: {
    fontFamily: fontFamilies.bold,
    fontSize: 14,
    letterSpacing: 0.2,
  },
  weekStatus: {
    fontFamily: fontFamilies.semibold,
    fontSize: 11.5,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  todayButton: {
    alignSelf: 'center',
    marginTop: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
  },
  todayButtonText: { fontFamily: fontFamilies.semibold, fontSize: 12.5 },
  errorBar: {
    marginHorizontal: 20,
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  daySelector: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 14,
    gap: 6,
  },
  dayChip: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 0,
    borderRadius: 12,
    alignItems: 'center',
  },
  dayLabel: {
    fontFamily: fontFamilies.semibold,
    fontSize: 10.5,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    opacity: 0.85,
  },
  dayNumber: {
    fontFamily: fontFamilies.displayBold,
    fontSize: 17,
    marginTop: 2,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 3,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl * 2,
    gap: spacing.sm,
  },
  dayTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 13,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  // Compact, fully-tappable planned entry (calendar-style row).
  entryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    minHeight: 64,
  },
  entryAccent: {
    width: 4,
    alignSelf: 'stretch',
  },
  entryThumb: {
    width: 48,
    height: 48,
    borderRadius: 10,
    overflow: 'hidden',
    marginLeft: 10,
    marginVertical: 8,
    backgroundColor: '#0002',
  },
  entryBody: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    justifyContent: 'center',
    minWidth: 0,
  },
  entryEyebrow: {
    fontFamily: fontFamilies.semibold,
    fontSize: 10.5,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  entryName: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 15,
    lineHeight: 19,
    letterSpacing: -0.2,
    marginTop: 1,
  },
  entryMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 4,
  },
  entryMetaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  entryMeta: { fontFamily: fontFamilies.regular, fontSize: 11.5 },
  cookedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  cookedBadgeText: {
    fontFamily: fontFamilies.bold,
    fontSize: 10.5,
    letterSpacing: 0.2,
  },
  entryChevron: {
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Slim, tappable "add recipe" slot.
  emptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  // Non-interactive variant for past (non-plannable) slots.
  emptyRowMuted: { opacity: 0.6 },
  emptyEyebrow: {
    fontFamily: fontFamilies.semibold,
    fontSize: 10.5,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    width: 92,
  },
  emptyText: {
    flex: 1,
    fontFamily: fontFamilies.semibold,
    fontSize: 13,
  },
  emptyState: {
    paddingTop: spacing.xxl,
    alignItems: 'center',
  },
  offerPlanButton: {
    marginHorizontal: 20,
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
  },
  offerPlanIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  offerPlanTextWrap: { flex: 1, minWidth: 0 },
  offerPlanTitle: { fontFamily: fontFamilies.bold, fontSize: 15, letterSpacing: -0.2 },
  offerPlanSub: { fontFamily: fontFamilies.regular, fontSize: 12.5, marginTop: 2 },
  shoppingButton: {
    marginHorizontal: 20,
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: radius.md,
  },
  shoppingButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fontFamilies.bold,
  },
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
  },
  toastText: { color: '#FFFFFF', fontSize: 15, fontFamily: fontFamilies.bold },
});
