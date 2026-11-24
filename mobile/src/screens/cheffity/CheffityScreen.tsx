import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Animated as RNAnimated,
  Dimensions,
  Image,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, fontFamilies, spacing, radius } from '../../theme';
import type { ThemeColors } from '../../theme';
import { useSubscription } from '../../store/SubscriptionContext';
import { usePreferences } from '../../store/PreferencesContext';
import { LockedFeature } from '../../components/common/LockedFeature';
import { Icon } from '../../components/common/Icon';
import { HeaderActions } from '../../components/common/HeaderActions';
import { RecipeIllustration } from '../../components/common/RecipeIllustration';
import { CheffityTutorial } from './CheffityTutorial';
import { RecipeDetailScreen } from './RecipeDetailScreen';
import { PantryRecipesView } from './PantryRecipesView';
import type { PantryViewMode } from './PantryRecipesView';
import { OfferRecipesView } from './OfferRecipesView';
import { ProvenanceBadge } from '../../components/common/ProvenanceBadge';
import { recipeProvenanceBadge } from '../../utils/recipeProvenance';
import {
  CUISINE_FILTER_CANDIDATES,
  CUISINE_SLUGS,
  getCuisineLabel,
  normalizeCuisine,
} from '../../utils/cuisine';
import type { CuisineSlug } from '../../utils/cuisine';
import { fetchRecipes } from '../../services/recipesApi';
import { fetchUserRecipeState, recordSwipe } from '../../services/swipesApi';
import { fetchPantryItems } from '../../services/pantryApi';
import { fetchRecipeTrends } from '../../services/trendsApi';
import { planRecipeToWeek } from '../../services/planRecipeFlow';
import { rankRecipesForYou, type RecipeReasonTag } from '../../utils/recipeRanking';
import { countValidRecipeDeals } from '../../utils/ingredientDeal';
import { RECIPE_REASON_I18N, getRecipeReasonBadges } from '../../utils/reasonBadges';
import { floatingTabBarClearance } from '../../navigation/components/FloatingGlassTabBar';
import { PlanRecipeSheet } from './components/PlanRecipeSheet';
import type { PlanRecipeChoice } from './components/PlanRecipeSheet';
import type { PantryItem, Recipe } from '../../types';

// Visible tabs are foryou / offers / pantry / almost. 'cheap' stays a valid
// PantryViewMode (its logic + i18n are kept) but is no longer offered as a tab.
type CheffityTab = 'foryou' | 'offers' | PantryViewMode;

const TUTORIAL_KEY = '@cheffity_tutorial_completed';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const X_THRESHOLD = SCREEN_W * 0.28;
const Y_THRESHOLD = 90;
const MAX_TILT_DEG = 14;
// A horizontal/vertical fling counts as a commit either past the distance
// threshold above or above this velocity (px/s) — a fast flick shouldn't
// need to cover the full distance.
const FLING_VELOCITY = 850;
// Gesture activation: pan must travel this far before it grabs the touch,
// so taps on the card buttons still register.
const ACTIVATION_OFFSET = 10;
// Direction lock-in: once the orthogonal axis moves past this, the pan on
// the competing axis fails — keeps horizontal and vertical cleanly separate.
const DIRECTION_LOCK = 16;
const COMMIT_DURATION = 220;
const SNAP_SPRING = { damping: 20, stiffness: 220 } as const;

export function CheffityScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { hasFeature, requiredTier } = useSubscription();
  const { preferences } = usePreferences();

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [bannedIds, setBannedIds] = useState<Set<string>>(new Set());
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  // Recipe awaiting the "Zum Wochenplan" sheet (from swipe OR a pantry card).
  const [pendingPlan, setPendingPlan] = useState<Recipe | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // Active pantry items, used by:
  //   - the new "Aus Lager" / "Fast fertig" tabs to rank recipes,
  //   - the "Fehlende zur Liste" action to skip what's already at home.
  // Loaded on mount alongside recipes; falls back to [] on error so the
  // pantry tabs render an empty-state instead of crashing.
  const [pantryItems, setPantryItems] = useState<PantryItem[]>([]);
  // Aggregated popularity (recipe_trend_30d): recipeId → planned-count-30d.
  // Best-effort signal for the "Für dich" hybrid ranking; empty on failure.
  const [recipeTrendMap, setRecipeTrendMap] = useState<Map<string, number>>(new Map());
  const [activeTab, setActiveTab] = useState<CheffityTab>('foryou');
  // Detail-modal context: which list to navigate inside, current index, and
  // whether index changes should propagate back to the swipe deck. Pantry-tab
  // opens use the ranked pantry list and DON'T touch the swipe index.
  const [detailContext, setDetailContext] = useState<
    | {
        list: Recipe[];
        index: number;
        source: 'swipe' | 'pantry';
      }
    | null
  >(null);
  const [tutorialState, setTutorialState] = useState<'unknown' | 'show' | 'done'>('unknown');

  useEffect(() => {
    if (!hasFeature('cheffity')) return;
    let cancelled = false;
    (async () => {
      try {
        // Pantry is loaded alongside recipes so the "Aus Lager" tab can rank
        // without a second round-trip. Failure here is non-fatal: the pantry
        // tabs degrade to an empty list, the swipe tab is unaffected.
        const [rows, state, pantryRows] = await Promise.all([
          fetchRecipes({ limit: 60, preferences }),
          fetchUserRecipeState(),
          fetchPantryItems().catch((error) => {
            console.warn(
              '[CheffityScreen] fetchPantryItems failed:',
              (error as Error).message,
            );
            return [] as PantryItem[];
          }),
        ]);
        if (cancelled) return;
        setBannedIds(state.bannedIds);
        setFavoriteIds(state.favoriteIds);
        setRecipes(rows);
        setPantryItems(pantryRows);
        // Trend popularity is a soft signal — load it separately so it never
        // blocks or fails the core recipe/pantry load.
        fetchRecipeTrends(60)
          .then((trends) => {
            if (cancelled) return;
            setRecipeTrendMap(new Map(trends.map((row) => [row.recipeId, row.plannedCount30d])));
          })
          .catch(() => {
            /* trends view unavailable — ranking just drops the trend signal */
          });
      } catch (error) {
        if (cancelled) return;
        console.warn('[CheffityScreen] initial load failed:', (error as Error).message);
        setRecipes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasFeature, preferences]);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(TUTORIAL_KEY).then((value) => {
      if (cancelled) return;
      setTutorialState(value === '1' ? 'done' : 'show');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTutorialDone = () => {
    setTutorialState('done');
    AsyncStorage.setItem(TUTORIAL_KEY, '1').catch(() => {});
  };

  // "Für dich" deck order: hybrid rank (pantry coverage, deals, time, favourite,
  // cuisine variety, trend, novelty − repetition/safety) instead of the raw
  // rating×created order. The list tabs (Lager/Fast/Günstig) re-rank by
  // coverage downstream, so this only sets the deck order + their stable
  // tie-break. Banned recipes are filtered out first.
  const forYouRanked = useMemo(() => {
    const notBanned = recipes.filter((r) => !bannedIds.has(r.id));
    return rankRecipesForYou(notBanned, {
      pantryItems,
      favoriteIds,
      trendByRecipeId: recipeTrendMap,
    });
  }, [recipes, bannedIds, pantryItems, favoriteIds, recipeTrendMap]);
  const visibleRecipes = useMemo(
    () => forYouRanked.map((scored) => scored.recipe),
    [forYouRanked],
  );
  // recipeId → reason tags for the "Für dich" deck cards. Only deck recipes
  // carry these; list-tab cards keep their coverage badges unchanged.
  const recipeReasons = useMemo(() => {
    const map = new Map<string, RecipeReasonTag[]>();
    for (const scored of forYouRanked) map.set(scored.recipe.id, scored.reasons);
    return map;
  }, [forYouRanked]);
  const deckLength = visibleRecipes.length;
  const currentRecipe = visibleRecipes[currentIndex];

  // Cuisine ("Küche") filter for the LIST tabs only (Aus Lager / Fast fertig /
  // Günstig). The swipe deck keeps the full `visibleRecipes` and is never
  // narrowed here, so its index logic stays intact. Only candidate cuisines
  // that actually have recipes get a chip — no dead chips for unseeded cuisines.
  const [cuisineFilter, setCuisineFilter] = useState<CuisineSlug | 'all'>('all');
  const cuisineOptions = useMemo(() => {
    const present = new Set(visibleRecipes.map((r) => normalizeCuisine(r.cuisine)));
    // Curated candidates first (stable, intentional order), then any other
    // cuisine that is actually present (e.g. oriental/indian/french/greek from
    // the seed) so EVERY recipe with a cuisine is filterable — not just the
    // curated subset. No dead chips: a slug only appears if recipes have it.
    const fromCandidates = CUISINE_FILTER_CANDIDATES.filter((slug) => present.has(slug));
    const extras = CUISINE_SLUGS.filter(
      (slug) => present.has(slug) && !CUISINE_FILTER_CANDIDATES.includes(slug),
    );
    return [...fromCandidates, ...extras];
  }, [visibleRecipes]);
  const pantryRecipes = useMemo(() => {
    if (cuisineFilter === 'all') return visibleRecipes;
    return visibleRecipes.filter((r) => normalizeCuisine(r.cuisine) === cuisineFilter);
  }, [visibleRecipes, cuisineFilter]);

  if (!hasFeature('cheffity')) {
    return (
      <LockedFeature requiredTier={requiredTier('cheffity')}>
        <View style={[styles.fill, { backgroundColor: colors.background }]} />
      </LockedFeature>
    );
  }

  // Cyclic navigation. Index only ever changes here (and via the detail
  // modal) — never mid-drag inside the deck.
  const goNext = () =>
    setCurrentIndex((i) => (deckLength ? (i + 1) % deckLength : 0));
  const goPrevious = () =>
    setCurrentIndex((i) => (deckLength ? (i - 1 + deckLength) % deckLength : 0));

  const handleSwipeLeft = () => {
    const recipe = visibleRecipes[currentIndex];
    if (recipe) {
      recordSwipe(recipe.id, 'not_now').catch((e) =>
        console.warn('[CheffityScreen] recordSwipe(not_now) failed:', (e as Error).message),
      );
    }
    goNext();
  };
  const handleSwipeRight = (recipe: Recipe) => setPendingPlan(recipe);
  const handlePlanRecipe = (recipe: Recipe) => setPendingPlan(recipe);
  const handleBan = (recipe: Recipe) => {
    setBannedIds((prev) => {
      const next = new Set(prev);
      next.add(recipe.id);
      return next;
    });
    // Ban removes the active card from visibleRecipes; the following card
    // shifts into the current slot. If the banned card was the last one,
    // wrap back to the start so the deck stays cyclic (no empty state).
    if (currentIndex >= deckLength - 1) {
      setCurrentIndex(0);
    }
    recordSwipe(recipe.id, 'never').catch((e) =>
      console.warn('[CheffityScreen] recordSwipe(never) failed:', (e as Error).message),
    );
  };
  const handleHeart = (recipe: Recipe) => {
    const wasFavorite = favoriteIds.has(recipe.id);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (wasFavorite) next.delete(recipe.id);
      else next.add(recipe.id);
      return next;
    });
    recordSwipe(recipe.id, wasFavorite ? 'unfavorite' : 'favorite').catch((e) =>
      console.warn('[CheffityScreen] recordSwipe(favorite) failed:', (e as Error).message),
    );
  };

  // Unified planning confirm — shared by the swipe deck and the
  // Lager/Fast/Günstig cards. The PlanRecipeSheet collects day/meal/portions/
  // add-missing; the persistence lives in `planRecipeToWeek` so every entry
  // point behaves identically.
  const handlePlanConfirm = async (choice: PlanRecipeChoice) => {
    const recipe = pendingPlan;
    setPendingPlan(null);
    if (!recipe) return;

    // Advance the deck only when the planned recipe is the active swipe card;
    // planning from a pantry card must not move the deck.
    const fromDeck = visibleRecipes[currentIndex]?.id === recipe.id;
    if (fromDeck) goNext();

    try {
      const result = await planRecipeToWeek({
        recipe,
        dayOfWeek: choice.dayOfWeek,
        mealType: choice.mealType,
        portions: choice.portions,
        defaultPortionSize: preferences.defaultPortionSize,
        addMissingToShopping: choice.addMissingToShopping,
        pantryItems,
      });
      setToastMessage(
        result.addedToShoppingCount > 0
          ? t('cheffity.planSheet.toastPlannedWithItems', { count: result.addedToShoppingCount })
          : t('cheffity.toastAdded'),
      );
    } catch (e) {
      console.warn('[CheffityScreen] planRecipeToWeek failed:', (e as Error).message);
      setToastMessage(t('cheffity.planSheet.toastError'));
    }
  };

  const handleDetailIndexChange = (next: number) => {
    setDetailContext((prev) => (prev ? { ...prev, index: next } : prev));
    // Only the swipe deck's index is mirrored back — pantry-tab detail
    // navigation is local to the modal.
    if (detailContext?.source === 'swipe') {
      setCurrentIndex(next);
    }
  };

  const handleDetailClose = () => {
    if (detailContext?.source === 'swipe') {
      setCurrentIndex(detailContext.index);
    }
    setDetailContext(null);
  };

  const openDetailFromSwipe = (index: number) => {
    setDetailContext({
      list: visibleRecipes,
      index,
      source: 'swipe',
    });
  };

  // Chrome (status bar + brand row + tab row) now lives in the normal flow
  // above the body — the pantry list only needs a little top padding.
  const pantryContentTopInset = spacing.md;
  // Clearance for the floating tab bar overlay (it no longer reserves layout).
  const tabBarSpace = floatingTabBarClearance(insets.bottom);

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <StatusBar barStyle="default" />

      {/* Chrome — header row + tab row, normal flow. No more absolute overlay. */}
      <View style={[styles.chrome, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.brandTitle, { color: colors.text }]}>Cheffity</Text>
          <HeaderActions color={colors.text} />
        </View>
        <View style={styles.tabRow}>
          <CheffityTabBar
            activeTab={activeTab}
            onChange={setActiveTab}
            colors={colors}
            t={t}
          />
        </View>
        {activeTab !== 'foryou' && cuisineOptions.length > 0 && (
          <CuisineFilterBar
            options={cuisineOptions}
            active={cuisineFilter}
            onChange={setCuisineFilter}
            colors={colors}
            t={t}
          />
        )}
      </View>

      {/* Body — fills the rest below the chrome */}
      <View style={styles.body}>
        {activeTab === 'foryou' ? (
          currentRecipe ? (
            <RecipeCardDeck
              recipes={visibleRecipes}
              index={currentIndex}
              favoriteIds={favoriteIds}
              reasonsByRecipeId={recipeReasons}
              bottomInset={tabBarSpace}
              colors={colors}
              t={t}
              onSwipeLeft={handleSwipeLeft}
              onSwipeRight={() => handleSwipeRight(currentRecipe)}
              onNext={goNext}
              onPrevious={goPrevious}
              onBan={() => handleBan(currentRecipe)}
              onHeart={() => handleHeart(currentRecipe)}
              onDetails={() => openDetailFromSwipe(currentIndex)}
            />
          ) : (
            <EmptyState colors={colors} message={t('cheffity.noRecipes')} />
          )
        ) : activeTab === 'offers' ? (
          <OfferRecipesView
            recipes={pantryRecipes}
            pantryItems={pantryItems}
            contentTopInset={pantryContentTopInset}
            bottomInset={tabBarSpace}
            filterActive={cuisineFilter !== 'all'}
            onResetFilter={() => setCuisineFilter('all')}
            onGoForYou={() => setActiveTab('foryou')}
            onOpenRecipe={(recipe) => {
              setDetailContext({ list: [recipe], index: 0, source: 'pantry' });
            }}
            onPlanRecipe={handlePlanRecipe}
          />
        ) : (
          <PantryRecipesView
            recipes={pantryRecipes}
            pantryItems={pantryItems}
            mode={activeTab}
            contentTopInset={pantryContentTopInset}
            bottomInset={tabBarSpace}
            onOpenRecipe={(recipe) => {
              setDetailContext({ list: [recipe], index: 0, source: 'pantry' });
            }}
            onPlanRecipe={handlePlanRecipe}
          />
        )}
      </View>

      <PlanRecipeSheet
        visible={pendingPlan != null}
        recipe={pendingPlan}
        defaultPortions={preferences.defaultPortionSize}
        pantryItems={pantryItems}
        colors={colors}
        t={t}
        onCancel={() => setPendingPlan(null)}
        onConfirm={handlePlanConfirm}
      />

      <Toast
        message={toastMessage}
        colors={colors}
        onDismiss={() => setToastMessage(null)}
      />

      <RecipeDetailScreen
        recipes={detailContext?.list ?? []}
        index={detailContext?.index ?? null}
        isFavorite={(id) => favoriteIds.has(id)}
        onClose={handleDetailClose}
        onIndexChange={handleDetailIndexChange}
        onToggleFavorite={handleHeart}
      />

      {tutorialState === 'show' && activeTab === 'foryou' && (
        <CheffityTutorial onDone={handleTutorialDone} />
      )}
    </View>
  );
}

// ─── CheffityTabBar — three-segment switch between deck and pantry views ───

interface TabBarProps {
  activeTab: CheffityTab;
  onChange: (next: CheffityTab) => void;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
}

function CheffityTabBar({ activeTab, onChange, colors, t }: TabBarProps) {
  const tabs: { id: CheffityTab; label: string }[] = [
    { id: 'foryou', label: t('cheffity.tabs.foryou') },
    { id: 'offers', label: t('cheffity.tabs.offers') },
    { id: 'pantry', label: t('cheffity.tabs.pantryShort') },
    { id: 'almost', label: t('cheffity.tabs.almostShort') },
  ];

  return (
    <View
      style={[
        tabBarStyles.container,
        { backgroundColor: colors.surface, borderColor: colors.borderLight },
      ]}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <Pressable
            key={tab.id}
            onPress={() => onChange(tab.id)}
            style={[
              tabBarStyles.tab,
              isActive && {
                backgroundColor: colors.surfaceElevated,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.08,
                shadowRadius: 3,
                elevation: 1,
              },
            ]}
            hitSlop={4}
          >
            <Text
              style={[
                tabBarStyles.tabLabel,
                {
                  color: isActive ? colors.text : colors.textSecondary,
                  fontFamily: isActive ? fontFamilies.bold : fontFamilies.semibold,
                },
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const tabBarStyles = StyleSheet.create({
  // Full-width segmented control. Each tab is flex:1 so all four labels
  // share the row equally and the last tab never gets clipped — no more
  // horizontal scroll, no reserved gutter for HeaderActions.
  container: {
    flexDirection: 'row',
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    gap: 2,
  },
  tab: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    fontSize: 13,
    fontFamily: fontFamilies.semibold,
    letterSpacing: -0.1,
  },
});

// ─── CuisineFilterBar — horizontal "Küche" chips for the list tabs ───────

interface CuisineFilterBarProps {
  options: CuisineSlug[];
  active: CuisineSlug | 'all';
  onChange: (next: CuisineSlug | 'all') => void;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
}

function CuisineFilterBar({
  options,
  active,
  onChange,
  colors,
  t,
}: CuisineFilterBarProps) {
  const chips: { id: CuisineSlug | 'all'; label: string }[] = [
    { id: 'all', label: t('cheffity.cuisineAll') },
    ...options.map((slug) => ({ id: slug, label: getCuisineLabel(slug, t) })),
  ];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={cuisineBarStyles.scroll}
      contentContainerStyle={cuisineBarStyles.content}
    >
      {chips.map((chip) => {
        const isActive = chip.id === active;
        return (
          <Pressable
            key={chip.id}
            onPress={() => onChange(chip.id)}
            hitSlop={4}
            style={[
              cuisineBarStyles.chip,
              {
                backgroundColor: isActive ? colors.primary : colors.surface,
                borderColor: isActive ? colors.primary : colors.borderLight,
              },
            ]}
          >
            <Text
              style={[
                cuisineBarStyles.chipLabel,
                { color: isActive ? '#FFFFFF' : colors.textSecondary },
              ]}
              numberOfLines={1}
            >
              {chip.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const cuisineBarStyles = StyleSheet.create({
  scroll: { marginTop: spacing.xs, flexGrow: 0 },
  content: { gap: 8, paddingVertical: 2, paddingRight: spacing.md },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 13,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipLabel: {
    fontSize: 12.5,
    fontFamily: fontFamilies.semibold,
    letterSpacing: -0.1,
  },
});

// ─── RecipeCardDeck — vertical A/B swipe deck for the recipe stack ───────
//
// Three positional slots, each a full-screen layer holding one CardFace:
//
//   slot-prev  baseOffset = -SCREEN_H  (above the viewport at rest)
//   slot-curr  baseOffset =  0         (the active card at rest)
//   slot-next  baseOffset = +SCREEN_H  (below the viewport at rest)
//
// `drag` is the SHARED vertical translation every slot adds to its
// baseOffset, so during a vertical pan the current card AND the incoming
// neighbour move in lockstep — both are already mounted off-viewport, so
// there's no late mount and no "B jumps in".
//
//   swipe up   → curr 0→-SCREEN_H, next +SCREEN_H→0  → commit onNext()
//   swipe down → curr 0→+SCREEN_H, prev -SCREEN_H→0  → commit onPrevious()
//
// currentIndex is owned by the parent and only changes AFTER the commit
// animation finishes (runOnJS(onNext/onPrevious)). On the resulting
// re-render the slot KEYS stay the same, so React keeps each slot instance
// and just hands it a new recipe; useLayoutEffect resets `drag` to 0 in the
// same commit, so the card that slid to centre lands at translateY=0 with
// the new recipe — same pixel, no flicker.
//
// Horizontal swipes are independent: a separate `cardX` shared value drives
// only the active card's translateX + tilt and keeps the original
// left = not_now / right = add-to-plan actions. The two gestures are raced
// and direction-locked (activeOffset on one axis, failOffset on the other)
// so a drag is cleanly either horizontal or vertical, never both.

interface RecipeCardDeckProps {
  recipes: Recipe[];
  index: number;
  favoriteIds: Set<string>;
  reasonsByRecipeId?: Map<string, RecipeReasonTag[]>;
  /** Bottom clearance for the floating tab bar (applied to each card). */
  bottomInset?: number;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onBan: () => void;
  onHeart: () => void;
  onDetails: () => void;
}

function RecipeCardDeck({
  recipes,
  index,
  favoriteIds,
  reasonsByRecipeId,
  bottomInset,
  colors,
  t,
  onSwipeLeft,
  onSwipeRight,
  onNext,
  onPrevious,
  onBan,
  onHeart,
  onDetails,
}: RecipeCardDeckProps) {
  const reduceMotion = useReducedMotion();

  const len = recipes.length;
  const canCycle = len > 1;

  const currentRecipe = recipes[index];
  const previousRecipe = canCycle
    ? recipes[(index - 1 + len) % len]
    : undefined;
  const nextRecipe = canCycle ? recipes[(index + 1) % len] : undefined;

  // drag: vertical translation shared by all three slots (+ = down).
  const drag = useSharedValue(0);
  // cardX: horizontal translation of the active card only (+ = right).
  const cardX = useSharedValue(0);
  // Locks both gestures while a commit/fly-off animation is in flight.
  const isTransitioning = useSharedValue(false);

  // After the parent applies the new index, both translations MUST reset to
  // 0 before the next paint, otherwise the card that just slid into the
  // centre would jump back out. useLayoutEffect runs after the React commit
  // but before paint.
  useLayoutEffect(() => {
    drag.value = 0;
    cardX.value = 0;
    isTransitioning.value = false;
  }, [index, drag, cardX, isTransitioning]);

  const verticalGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-ACTIVATION_OFFSET, ACTIVATION_OFFSET])
        .failOffsetX([-DIRECTION_LOCK, DIRECTION_LOCK])
        .onUpdate((event) => {
          if (isTransitioning.value || !canCycle) return;
          drag.value = event.translationY;
        })
        .onEnd((event) => {
          if (isTransitioning.value || !canCycle) return;
          const committed = drag.value;
          const past =
            Math.abs(committed) > Y_THRESHOLD ||
            Math.abs(event.velocityY) > FLING_VELOCITY;
          if (!past || Math.abs(committed) < 1) {
            drag.value = withSpring(0, SNAP_SPRING);
            return;
          }
          // Down (positive) reveals the previous card; up reveals the next.
          const goingDown = committed > 0;
          if (reduceMotion) {
            drag.value = 0;
            runOnJS(goingDown ? onPrevious : onNext)();
            return;
          }
          isTransitioning.value = true;
          drag.value = withTiming(
            goingDown ? SCREEN_H : -SCREEN_H,
            { duration: COMMIT_DURATION },
            (finished) => {
              if (finished) runOnJS(goingDown ? onPrevious : onNext)();
              else isTransitioning.value = false;
            },
          );
        }),
    // commit closures capture `index` indirectly via onNext/onPrevious; the
    // gesture is cheap to rebuild whenever cyclability or motion pref flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canCycle, reduceMotion, onNext, onPrevious],
  );

  const horizontalGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-ACTIVATION_OFFSET, ACTIVATION_OFFSET])
        .failOffsetY([-DIRECTION_LOCK, DIRECTION_LOCK])
        .onUpdate((event) => {
          if (isTransitioning.value) return;
          cardX.value = event.translationX;
        })
        .onEnd((event) => {
          if (isTransitioning.value) return;
          const committed = cardX.value;
          const past =
            Math.abs(committed) > X_THRESHOLD ||
            Math.abs(event.velocityX) > FLING_VELOCITY;
          if (!past) {
            cardX.value = withSpring(0, SNAP_SPRING);
            return;
          }
          const goingRight = committed > 0;
          if (reduceMotion) {
            cardX.value = 0;
            runOnJS(goingRight ? onSwipeRight : onSwipeLeft)();
            return;
          }
          isTransitioning.value = true;
          cardX.value = withTiming(
            goingRight ? SCREEN_W * 1.4 : -SCREEN_W * 1.4,
            { duration: COMMIT_DURATION },
            (finished) => {
              if (!finished) {
                isTransitioning.value = false;
                return;
              }
              if (goingRight) {
                // Right swipe opens the portion modal but does NOT advance
                // the index, so snap the card back to centre (covered by
                // the modal) before firing.
                cardX.value = 0;
                isTransitioning.value = false;
                runOnJS(onSwipeRight)();
              } else {
                // Left swipe advances the index; the layout effect resets
                // cardX once the new card mounts in the centre slot.
                runOnJS(onSwipeLeft)();
              }
            },
          );
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reduceMotion, onSwipeLeft, onSwipeRight],
  );

  const gesture = useMemo(
    () => Gesture.Race(verticalGesture, horizontalGesture),
    [verticalGesture, horizontalGesture],
  );

  // Per-slot vertical translation.
  const prevSlotStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -SCREEN_H + drag.value }],
  }));
  const currSlotStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drag.value }],
  }));
  const nextSlotStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: SCREEN_H + drag.value }],
  }));

  // Active card horizontal translation + tilt.
  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: cardX.value },
      {
        rotate: `${interpolate(
          cardX.value,
          [-SCREEN_W, 0, SCREEN_W],
          [-MAX_TILT_DEG, 0, MAX_TILT_DEG],
          Extrapolation.CLAMP,
        )}deg`,
      },
    ],
  }));
  const leftHintStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      cardX.value,
      [-X_THRESHOLD, -X_THRESHOLD * 0.4, 0],
      [1, 0.5, 0],
      Extrapolation.CLAMP,
    ),
  }));
  const rightHintStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      cardX.value,
      [0, X_THRESHOLD * 0.4, X_THRESHOLD],
      [0, 0.5, 1],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.fill}>
        {previousRecipe && (
          <Reanimated.View
            key="slot-prev"
            style={[styles.paneLayer, prevSlotStyle]}
            pointerEvents="none"
          >
            <CardFace
              recipe={previousRecipe}
              isFavorite={favoriteIds.has(previousRecipe.id)}
              reasonTags={reasonsByRecipeId?.get(previousRecipe.id)}
              bottomInset={bottomInset}
              colors={colors}
              t={t}
              active={false}
            />
          </Reanimated.View>
        )}

        <Reanimated.View
          key="slot-curr"
          style={[styles.paneLayer, currSlotStyle]}
        >
          <CardFace
            recipe={currentRecipe}
            isFavorite={favoriteIds.has(currentRecipe.id)}
            reasonTags={reasonsByRecipeId?.get(currentRecipe.id)}
            bottomInset={bottomInset}
            colors={colors}
            t={t}
            active
            cardStyle={cardStyle}
            leftHintStyle={leftHintStyle}
            rightHintStyle={rightHintStyle}
            onBan={onBan}
            onHeart={onHeart}
            onDetails={onDetails}
          />
        </Reanimated.View>

        {nextRecipe && (
          <Reanimated.View
            key="slot-next"
            style={[styles.paneLayer, nextSlotStyle]}
            pointerEvents="none"
          >
            <CardFace
              recipe={nextRecipe}
              isFavorite={favoriteIds.has(nextRecipe.id)}
              reasonTags={reasonsByRecipeId?.get(nextRecipe.id)}
              bottomInset={bottomInset}
              colors={colors}
              t={t}
              active={false}
            />
          </Reanimated.View>
        )}
      </View>
    </GestureDetector>
  );
}

// ─── CardFace — the visual recipe card (no gesture state of its own) ─────

interface CardFaceProps {
  recipe: Recipe;
  isFavorite: boolean;
  reasonTags?: RecipeReasonTag[];
  /** Floating-tab-bar clearance applied to the card's bottom padding. */
  bottomInset?: number;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  active: boolean;
  /** Animated translateX + tilt — only the active card receives these. */
  cardStyle?: ReturnType<typeof useAnimatedStyle>;
  leftHintStyle?: ReturnType<typeof useAnimatedStyle>;
  rightHintStyle?: ReturnType<typeof useAnimatedStyle>;
  onBan?: () => void;
  onHeart?: () => void;
  onDetails?: () => void;
}

function CardFace({
  recipe,
  isFavorite,
  reasonTags,
  bottomInset,
  colors,
  t,
  active,
  cardStyle,
  leftHintStyle,
  rightHintStyle,
  onBan,
  onHeart,
  onDetails,
}: CardFaceProps) {
  // Only concrete, currently-valid deals count toward the swipe-card badge —
  // a bare `isDeal: true` flag is a potential deal with no data behind it.
  // Same rule as the offers tab and recipe detail (countValidRecipeDeals ===
  // recipeOfferInfo(...).validDealCount). No real deals → no badge.
  const dealCount = countValidRecipeDeals(recipe);
  const rating = recipe.rating ?? 0;
  const ratingCount = recipe.ratingCount ?? 0;
  const commentCount = recipe.commentCount ?? 0;
  const fullStars = Math.round(rating);

  return (
    <View
      style={[
        styles.cardWrap,
        // Card runs full-bleed UNDER the floating tab bar — only a tiny bottom
        // margin. The tab-bar clearance is applied to the inner content block
        // (see styles.bottom override) so text/chips/Details stay above the bar
        // while the card background/gradient continues behind it.
        { paddingTop: spacing.sm, paddingBottom: spacing.sm },
      ]}
    >
      {/* peeking second card behind */}
      <View
        pointerEvents="none"
        style={[styles.peekCard, { backgroundColor: colors.surface }]}
      />

      <Reanimated.View style={[styles.card, cardStyle]}>
        {recipe.imageUrl ? (
          <Image source={{ uri: recipe.imageUrl }} style={styles.cardImage} />
        ) : (
          <View style={styles.cardImage}>
            <RecipeIllustration recipeId={recipe.id} />
          </View>
        )}

        <LinearGradient
          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.88)']}
          locations={[0, 0.55, 1]}
          style={styles.gradient}
          pointerEvents="none"
        />

        {/* Hint labels — active card only (driven by cardX). */}
        {active && (
          <>
            <Reanimated.View
              style={[
                styles.hint,
                styles.hintLeft,
                { top: 110, borderColor: '#EF4444' },
                leftHintStyle,
              ]}
              pointerEvents="none"
            >
              <Text style={[styles.hintText, { color: '#EF4444' }]}>
                {t('cheffity.hintNotNow')}
              </Text>
            </Reanimated.View>
            <Reanimated.View
              style={[
                styles.hint,
                styles.hintRight,
                { top: 110, borderColor: '#10B981' },
                rightHintStyle,
              ]}
              pointerEvents="none"
            >
              <Text style={[styles.hintText, { color: '#10B981' }]}>
                {t('cheffity.hintAddToPlan')}
              </Text>
            </Reanimated.View>
          </>
        )}

        {/* Top row: ban / deal badge / heart */}
        <View style={styles.topRow}>
          <Pressable
            onPress={onBan}
            style={styles.cornerButton}
            hitSlop={8}
            disabled={!active}
          >
            <View style={styles.cornerCircle}>
              <Icon name="ban" size={20} color="#EF4444" />
            </View>
          </Pressable>

          {dealCount > 0 && (
            <Pressable
              onPress={onDetails}
              disabled={!active}
              style={[styles.dealPill, { backgroundColor: colors.primary }]}
              hitSlop={6}
            >
              <Icon name="tag" size={14} color="#FFF" active />
              <Text style={styles.dealPillText} numberOfLines={1}>
                {t('cheffity.dealsBadge', { count: dealCount })}
              </Text>
            </Pressable>
          )}

          <Pressable
            onPress={onHeart}
            style={styles.cornerButton}
            hitSlop={8}
            disabled={!active}
          >
            <View style={styles.cornerCircle}>
              <Icon
                name="heart"
                size={20}
                color={isFavorite ? '#EF4444' : '#FFFFFF'}
                active={isFavorite}
              />
            </View>
          </Pressable>
        </View>

        {/* Bottom content — lifted above the floating tab bar via bottomInset,
            so the card background still runs full-bleed behind the bar but the
            title/chips/Details button stay clearly above it. */}
        <View style={[styles.bottom, { bottom: (bottomInset ?? 0) + 16 }]}>
          {(() => {
            const badge = recipeProvenanceBadge(recipe);
            return badge ? (
              <View style={styles.provenanceRow}>
                <ProvenanceBadge badge={badge} variant="dark" />
              </View>
            ) : null;
          })()}
          {(() => {
            const reasonBadges = getRecipeReasonBadges(reasonTags);
            return reasonBadges.length > 0 ? (
              <View style={styles.reasonRow}>
                {reasonBadges.map((tag) => (
                  <View key={`reason-${tag}`} style={styles.reasonChip}>
                    <Text style={styles.reasonChipText}>{t(RECIPE_REASON_I18N[tag])}</Text>
                  </View>
                ))}
              </View>
            ) : null;
          })()}
          <Text style={styles.dishName} numberOfLines={2}>
            {recipe.name}
          </Text>
          {recipe.introText ? (
            <Text style={styles.dishSubtitle} numberOfLines={1}>
              {recipe.introText}
            </Text>
          ) : null}

          <View style={styles.metaRow}>
            <View style={styles.starsRow}>
              {Array.from({ length: 5 }).map((_, i) => (
                <Icon
                  key={i}
                  name="star"
                  size={13}
                  color={i < fullStars ? '#FFC857' : 'rgba(255,255,255,0.35)'}
                  active={i < fullStars}
                />
              ))}
            </View>
            <Text style={styles.metaText}>{rating > 0 ? rating.toFixed(1) : '—'}</Text>
            <Text style={styles.metaTextDim}>
              ({ratingCount.toLocaleString('de-DE')})
            </Text>
            <View style={styles.metaIconRow}>
              <Icon name="comment" size={13} color="rgba(255,255,255,0.7)" />
              <Text style={styles.metaTextDim}>{commentCount}</Text>
            </View>
          </View>

          <View style={styles.metaRow}>
            {recipe.cuisine ? (
              <View style={styles.difficultyBadge}>
                <Text style={styles.difficultyText}>
                  {getCuisineLabel(normalizeCuisine(recipe.cuisine), t)}
                </Text>
              </View>
            ) : null}
            <View style={styles.difficultyBadge}>
              <Text style={styles.difficultyText}>
                {t(`cheffity.difficulty.${recipe.difficulty}`)}
              </Text>
            </View>
            <View style={styles.metaIconRow}>
              <Icon name="clock" size={13} color="rgba(255,255,255,0.85)" />
              <Text style={styles.metaTextLight}>
                {t('cheffity.cookTime', { minutes: recipe.cookTimeMinutes })}
              </Text>
            </View>
            {recipe.nutritionPerServing?.calories ? (
              <View style={styles.metaIconRow}>
                <Icon name="flame" size={13} color="rgba(255,255,255,0.85)" />
                <Text style={styles.metaTextLight}>
                  {recipe.nutritionPerServing.calories} kcal
                </Text>
              </View>
            ) : null}
          </View>

          <Pressable
            style={styles.detailsButton}
            onPress={onDetails}
            disabled={!active}
          >
            <Text style={styles.detailsButtonText}>{t('cheffity.details')}</Text>
          </Pressable>
        </View>
      </Reanimated.View>
    </View>
  );
}


interface ToastProps {
  message: string | null;
  colors: ThemeColors;
  onDismiss: () => void;
}

function Toast({ message, colors, onDismiss }: ToastProps) {
  const insets = useSafeAreaInsets();
  const opacity = useRef(new RNAnimated.Value(0)).current;
  const translateY = useRef(new RNAnimated.Value(-20)).current;

  useEffect(() => {
    if (!message) return;
    RNAnimated.parallel([
      RNAnimated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      RNAnimated.timing(translateY, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start();
    const timer = setTimeout(() => {
      RNAnimated.parallel([
        RNAnimated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
        RNAnimated.timing(translateY, { toValue: -20, duration: 180, useNativeDriver: true }),
      ]).start(() => onDismiss());
    }, 2200);
    return () => clearTimeout(timer);
  }, [message, opacity, translateY, onDismiss]);

  if (!message) return null;

  return (
    <RNAnimated.View
      style={[
        styles.toast,
        {
          top: insets.top + spacing.sm,
          backgroundColor: colors.accent,
          opacity,
          transform: [{ translateY }],
        },
      ]}
      pointerEvents="none"
    >
      <Text style={styles.toastText}>{message}</Text>
    </RNAnimated.View>
  );
}

function EmptyState({ colors, message }: { colors: ThemeColors; message: string }) {
  return (
    <View style={[styles.fill, styles.empty, { backgroundColor: colors.background }]}>
      <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  empty: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.xl },
  // Top chrome: brand row + tab row in normal flow above the body.
  chrome: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingVertical: spacing.xs,
  },
  brandTitle: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 22,
    letterSpacing: -0.4,
  },
  tabRow: {
    marginTop: spacing.xs,
  },
  body: {
    flex: 1,
  },
  // Each deck slot fills the screen; translateY moves it relative to the
  // viewport so neighbours sit just off-screen, fully mounted.
  paneLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  cardWrap: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  peekCard: {
    position: 'absolute',
    left: 26,
    right: 26,
    top: 88,
    bottom: 24,
    borderRadius: 28,
    opacity: 0.55,
    transform: [{ scale: 0.96 }, { translateY: 8 }],
  },
  card: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderRadius: 32,
    // Minimal shadow only. A heavier downward shadow darkened the gap below the
    // card and merged it with the floating tab bar into a dark "podest". The
    // separation now comes from the clean air gap, not a dark shadow.
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
  },
  cardImage: {
    ...StyleSheet.absoluteFillObject,
    width: undefined,
    height: undefined,
    resizeMode: 'cover',
    overflow: 'hidden',
  },
  gradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '60%',
  },
  topRow: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cornerButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cornerCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dealPill: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
    maxWidth: '65%',
  },
  dealPillText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontFamily: fontFamilies.bold,
    textAlign: 'center',
  },
  hint: {
    position: 'absolute',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 3,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  hintLeft: { right: 26, transform: [{ rotate: '12deg' }] },
  hintRight: { left: 26, transform: [{ rotate: '-12deg' }] },
  hintText: {
    fontSize: 18,
    fontFamily: fontFamilies.extrabold,
    letterSpacing: 1.5,
  },
  bottom: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 20,
  },
  dishName: {
    color: '#FFFFFF',
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 30,
    lineHeight: 34,
    letterSpacing: -0.5,
    marginBottom: 4,
  },
  provenanceRow: { marginBottom: 8, flexDirection: 'row' },
  // "Warum"-Badges over the dark card photo — small, translucent, white text.
  reasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  reasonChip: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  reasonChipText: {
    color: '#FFFFFF',
    fontSize: 11.5,
    fontFamily: fontFamilies.semibold,
    letterSpacing: 0.1,
  },
  dishSubtitle: {
    color: 'rgba(255,255,255,0.85)',
    fontFamily: fontFamilies.regular,
    fontSize: 14,
    fontStyle: 'italic',
    marginBottom: 14,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  metaIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  starsRow: { flexDirection: 'row', gap: 1 },
  metaText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontFamily: fontFamilies.semibold,
  },
  metaTextDim: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    fontFamily: fontFamilies.regular,
  },
  metaTextLight: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontFamily: fontFamilies.regular,
  },
  difficultyBadge: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  difficultyText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontFamily: fontFamilies.semibold,
  },
  detailsButton: {
    marginTop: 14,
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  detailsButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fontFamilies.semibold,
  },

  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
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
  toastText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
