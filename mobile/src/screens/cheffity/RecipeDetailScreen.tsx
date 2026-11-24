import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Dimensions,
  Image,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { LinearGradient } from 'expo-linear-gradient';
import {
  useThemeColors,
  typography,
  fontFamilies,
  spacing,
  radius,
} from '../../theme';
import type { ThemeColors } from '../../theme';
import { fetchCommentsForRecipe, submitComment } from '../../services/commentsApi';
import { logCookedRecipe } from '../../services/cookLogApi';
import { logRecipeAsMeal } from '../../services/dietTrackingApi';
import { useSubscription } from '../../store/SubscriptionContext';
import { fetchPantryItems } from '../../services/pantryApi';
import { addShoppingItem } from '../../services/shoppingListApi';
import { planRecipeToWeek } from '../../services/planRecipeFlow';
import { buildPlanShoppingItems } from '../../utils/planning';
import { ingredientHasConcreteDeal, buildIngredientDealShoppingItem } from '../../utils/ingredientDeal';
import {
  classifyDetailIngredient,
  scaleIngredientAmount,
  selectRecipeOffers,
  summarizeRecipeShop,
} from '../../utils/recipeShop';
import type { DetailIngredientStatus, RecipeShopSummary } from '../../utils/recipeShop';
import { IngredientDealSheet } from './components/IngredientDealSheet';
import { usePreferences } from '../../store/PreferencesContext';
import { AddCommentModal } from './AddCommentModal';
import { PlanRecipeSheet } from './components/PlanRecipeSheet';
import type { PlanRecipeChoice } from './components/PlanRecipeSheet';
import { Icon } from '../../components/common/Icon';
import type { IconName } from '../../components/common/Icon';
import { RecipeIllustration } from '../../components/common/RecipeIllustration';
import { ProductThumb, thumbSeed, thumbTint } from '../../components/deals/ProductThumb';
import { formatEuro, formatShortDate } from '../../components/deals/dealsTheme';
import { shouldShowAiSafetyNotice } from '../../utils/recipeProvenance';
import { getCuisineLabel, normalizeCuisine } from '../../utils/cuisine';
import type { PantryItem, Recipe, RecipeComment, RecipeIngredient } from '../../types';

// ─── Constants ────────────────────────────────────────────────────────────

const HEADER_IMAGE_HEIGHT = 320;
// Clearance so the last section isn't hidden behind the sticky buy-bar.
const STICKY_BAR_CLEARANCE = 104;
// How many comments the quiet inline block shows before "add comment".
const INLINE_COMMENT_LIMIT = 3;

// Captured once at module load; the modal mounts/unmounts per session.
const SCREEN_HEIGHT = Dimensions.get('window').height;

// How far the user must pan past a scroll edge before a release counts as
// a commit. Velocity is the second commit path (a fast flick).
// Tuned 2026-05-18: 140→110 px is more forgiving — most users intuitively
// undershoot the threshold on a normal swipe.
const DECK_DISTANCE_THRESHOLD = 110;
const DECK_VELOCITY_THRESHOLD = 850;
// Pan must travel at least this many pixels before it activates. Lower
// values feel snappier but also more triggery during normal reading.
// Tuned 2026-05-18: 15→10 px is still well above any accidental jiggle
// from a sit-still tap but reduces the perceived "stickiness".
const DECK_ACTIVATION_OFFSET = 10;
// Scroll-edge tolerance: how close to the top/bottom counts as "at edge".
// Tuned from 1→2 to absorb sub-pixel rubber-band oscillation that briefly
// nudges scrollY off the rail when the user is already pulling.
const DECK_EDGE_SLACK = 2;

type TFunc = (k: string, opts?: Record<string, unknown>) => string;

// ─── Public API ──────────────────────────────────────────────────────────

interface Props {
  recipes: Recipe[];
  /** null = modal closed; otherwise = index into `recipes`. */
  index: number | null;
  isFavorite: (recipeId: string) => boolean;
  onClose: () => void;
  /** Called after a deck commit completes (cyclic — caller may receive
   *  recipes.length-1 → 0 or 0 → recipes.length-1). */
  onIndexChange: (next: number) => void;
  onToggleFavorite: (recipe: Recipe) => void;
}

export function RecipeDetailScreen({
  recipes,
  index,
  isFavorite,
  onClose,
  onIndexChange,
  onToggleFavorite,
}: Props) {
  const visible =
    index !== null && index >= 0 && index < recipes.length;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
    >
      {visible && (
        <RecipeDeck
          recipes={recipes}
          index={index!}
          isFavorite={isFavorite}
          onClose={onClose}
          onIndexChange={onIndexChange}
          onToggleFavorite={onToggleFavorite}
        />
      )}
    </Modal>
  );
}

// ─── RecipeDeck — the 3-slot cyclic controller ──────────────────────────
//
// Three positional slots, each rendered as a full RecipePane:
//
//   slot-prev  baseOffset = -SCREEN_HEIGHT  (above the viewport at rest)
//   slot-curr  baseOffset =  0              (the active pane at rest)
//   slot-next  baseOffset = +SCREEN_HEIGHT  (below the viewport at rest)
//
// Each slot's translateY is `baseOffset + drag.value`. While the user
// drags, both the current AND the incoming neighbour are visible and move
// in lockstep — there is no late mount, no preview-to-full swap.
//
// On commit, the gesture animates `drag` to ±SCREEN_HEIGHT, then calls
// `onIndexChange(next)`. The parent updates its index state, this deck
// re-renders with the recipe list shifted by one. The slot KEYS stay the
// same ('slot-prev'/'slot-curr'/'slot-next'), so React preserves each
// slot's React instance and just hands it a new `recipe` prop.
//
// The visually-decisive trick is the useLayoutEffect below: it resets
// `drag.value` to 0 in the same React commit as the index change, so the
// pane that just slid to translateY=0 with the new "next" recipe lands
// in the slot-curr slot (baseOffset=0) at translateY=0 — same pixel,
// same recipe — without a frame of inconsistency.

interface DeckProps {
  recipes: Recipe[];
  index: number;
  isFavorite: (recipeId: string) => boolean;
  onClose: () => void;
  onIndexChange: (next: number) => void;
  onToggleFavorite: (recipe: Recipe) => void;
}

function RecipeDeck({
  recipes,
  index,
  isFavorite,
  onClose,
  onIndexChange,
  onToggleFavorite,
}: DeckProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const { preferences } = usePreferences();

  // "Zum Wochenplan"-Sheet shared with the swipe flow + pantry lists. Opened
  // from the active pane's "Woche planen" button; persisted via planRecipeToWeek.
  const [planSheetRecipe, setPlanSheetRecipe] = useState<Recipe | null>(null);
  const [plannedToast, setPlannedToast] = useState<string | null>(null);

  const recipesLen = recipes.length;
  const canCycle = recipesLen > 1;

  const currentRecipe = recipes[index];
  const previousRecipe = canCycle
    ? recipes[(index - 1 + recipesLen) % recipesLen]
    : undefined;
  const nextRecipe = canCycle
    ? recipes[(index + 1) % recipesLen]
    : undefined;

  // ── Animation state ──
  // drag: signed translation in pixels (+ = pulling down, − = pulling up).
  // Bounded by [-SCREEN_HEIGHT, SCREEN_HEIGHT].
  const drag = useSharedValue(0);
  // Scroll state of the ACTIVE pane only. Non-active panes are static.
  const scrollY = useSharedValue(0);
  const maxScrollY = useSharedValue(0);
  // Locks the gesture while a commit animation is in flight.
  const isTransitioning = useSharedValue(false);
  // Mirror JS-side neighbour availability into the worklet world so the
  // gesture can gate activation cheaply.
  const hasPrevious = useSharedValue(previousRecipe !== undefined);
  const hasNext = useSharedValue(nextRecipe !== undefined);

  useEffect(() => {
    hasPrevious.value = previousRecipe !== undefined;
  }, [hasPrevious, previousRecipe]);
  useEffect(() => {
    hasNext.value = nextRecipe !== undefined;
  }, [hasNext, nextRecipe]);

  // Active (not-consumed) pantry items, loaded once for the whole deck so the
  // ingredient list can mark what's already at home. Consumed items are
  // excluded by fetchPantryItems' default filter.
  const [pantryItems, setPantryItems] = useState<PantryItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchPantryItems()
      .then((rows) => {
        if (!cancelled) setPantryItems(rows);
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn(
            '[RecipeDetailScreen] fetchPantryItems failed:',
            (error as Error).message,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The active pane's ScrollView ref — gesture-handler reads this for
  // simultaneousWithExternalGesture so the pan and the scroll co-exist.
  const scrollRef = useRef<Animated.ScrollView | null>(null);

  // After the parent applies the new index, drag MUST reset to 0 BEFORE
  // the next paint, otherwise the pane that just slid into the centre
  // would jump back out. useLayoutEffect runs synchronously after the
  // React commit but before paint; the .value setter from JS schedules a
  // UI-thread update that lands in the same frame as the React layout.
  useLayoutEffect(() => {
    drag.value = 0;
    scrollY.value = 0;
    maxScrollY.value = 0;
    isTransitioning.value = false;
  }, [index, drag, scrollY, maxScrollY, isTransitioning]);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      const max = Math.max(
        0,
        event.contentSize.height - event.layoutMeasurement.height,
      );
      maxScrollY.value = max;
      scrollY.value = Math.min(Math.max(event.contentOffset.y, 0), max);
    },
  });

  // `index` is captured per closure; runOnJS hands it to JS thread.
  const commit = (direction: -1 | 1) => {
    const next = (index + direction + recipesLen) % recipesLen;
    onIndexChange(next);
    // drag is reset in useLayoutEffect when the new index arrives.
  };

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-DECK_ACTIVATION_OFFSET, DECK_ACTIVATION_OFFSET])
        .failOffsetX([-12, 12])
        .simultaneousWithExternalGesture(
          // Known gesture-handler ↔ React 19 nominal ref-type mismatch
          // (RefObject<T | null> vs RefObject<T | undefined>).
          scrollRef as unknown as React.RefObject<React.ComponentType>,
        )
        .onUpdate((event) => {
          if (isTransitioning.value) return;
          const dy = event.translationY;
          // Down-drag (positive) → preview previous, only when at scroll
          // top AND a previous neighbour exists.
          if (dy > 0) {
            if (hasPrevious.value && scrollY.value <= DECK_EDGE_SLACK) {
              drag.value = dy;
            } else if (drag.value !== 0) {
              // Conditions no longer met (e.g. user started scrolling) —
              // hide the half-revealed neighbour cleanly.
              drag.value = withSpring(0, { damping: 20, stiffness: 220 });
            }
            return;
          }
          // Up-drag (negative) → preview next, only when at scroll bottom
          // AND a next neighbour exists.
          if (dy < 0) {
            if (
              hasNext.value &&
              scrollY.value >= maxScrollY.value - DECK_EDGE_SLACK
            ) {
              drag.value = dy;
            } else if (drag.value !== 0) {
              drag.value = withSpring(0, { damping: 20, stiffness: 220 });
            }
            return;
          }
        })
        .onEnd((event) => {
          if (isTransitioning.value) return;
          const committed = drag.value;
          if (Math.abs(committed) < 5) {
            drag.value = withSpring(0, { damping: 20, stiffness: 220 });
            return;
          }
          const past =
            Math.abs(committed) > DECK_DISTANCE_THRESHOLD ||
            Math.abs(event.velocityY) > DECK_VELOCITY_THRESHOLD;
          if (!past) {
            drag.value = withSpring(0, { damping: 20, stiffness: 220 });
            return;
          }
          const direction: -1 | 1 = committed > 0 ? 1 : -1;
          if (reduceMotion) {
            drag.value = 0;
            runOnJS(commit)(direction);
            return;
          }
          isTransitioning.value = true;
          const target = direction * SCREEN_HEIGHT;
          drag.value = withTiming(
            target,
            { duration: 220 },
            (finished) => {
              if (finished) runOnJS(commit)(direction);
              else isTransitioning.value = false;
            },
          );
        }),
    // Rebuild the gesture when reduced-motion preference flips. `commit`
    // closes over `index` which changes on each commit — we read it via
    // the closure, which is fine because we want the LATEST index when
    // computing the next one. React rebuilds the gesture on each render
    // (cheap) so the closure stays fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reduceMotion, index, recipesLen],
  );

  // Per-slot translation styles. drag is the SHARED amount that all three
  // slots add to their baseOffset.
  const prevStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -SCREEN_HEIGHT + drag.value }],
  }));
  const currStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drag.value }],
  }));
  const nextStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: SCREEN_HEIGHT + drag.value }],
  }));

  const handlePlanConfirm = async (choice: PlanRecipeChoice) => {
    const recipe = planSheetRecipe;
    setPlanSheetRecipe(null);
    if (!recipe) return;
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
      setPlannedToast(
        result.addedToShoppingCount > 0
          ? t('cheffity.planSheet.toastPlannedWithItems', { count: result.addedToShoppingCount })
          : t('cheffity.toastAdded'),
      );
    } catch (e) {
      console.warn('[RecipeDetailScreen] planRecipeToWeek failed:', (e as Error).message);
      setPlannedToast(t('cheffity.planSheet.toastError'));
    }
    setTimeout(() => setPlannedToast(null), 2400);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <GestureDetector gesture={gesture}>
        <View style={styles.fill}>
          {/* slot-prev: above the viewport at rest, slides down into
              view when user pulls the current page down at scroll-top. */}
          {previousRecipe && (
            <Animated.View
              key="slot-prev"
              style={[styles.paneLayer, prevStyle]}
              pointerEvents="none"
            >
              <RecipePane
                recipe={previousRecipe}
                colors={colors}
                insets={insets}
                t={t}
                pantryItems={pantryItems}
                isFavorite={isFavorite(previousRecipe.id)}
                onToggleFavorite={() => onToggleFavorite(previousRecipe)}
                isActive={false}
              />
            </Animated.View>
          )}

          {/* slot-curr: the active pane. Receives the deck's scroll
              ref+handler so the gesture's edge-check stays in sync. */}
          <Animated.View
            key="slot-curr"
            style={[styles.paneLayer, currStyle]}
          >
            <RecipePane
              recipe={currentRecipe}
              colors={colors}
              insets={insets}
              t={t}
              pantryItems={pantryItems}
              isFavorite={isFavorite(currentRecipe.id)}
              onToggleFavorite={() => onToggleFavorite(currentRecipe)}
              onPlanRecipe={() => setPlanSheetRecipe(currentRecipe)}
              isActive
              scrollRef={scrollRef}
              scrollHandler={scrollHandler}
            />
          </Animated.View>

          {/* slot-next: below the viewport at rest, slides up into view
              when user pulls the current page up at scroll-bottom. */}
          {nextRecipe && (
            <Animated.View
              key="slot-next"
              style={[styles.paneLayer, nextStyle]}
              pointerEvents="none"
            >
              <RecipePane
                recipe={nextRecipe}
                colors={colors}
                insets={insets}
                t={t}
                pantryItems={pantryItems}
                isFavorite={isFavorite(nextRecipe.id)}
                onToggleFavorite={() => onToggleFavorite(nextRecipe)}
                isActive={false}
              />
            </Animated.View>
          )}
        </View>
      </GestureDetector>

      {/* Back button — fixed above the deck, unaffected by drag.
          The only close affordance per the latest spec. */}
      <Pressable
        onPress={onClose}
        style={[
          styles.cornerButton,
          { top: insets.top + spacing.sm, left: spacing.md },
        ]}
        hitSlop={8}
      >
        <Icon name="arrow-left" size={20} color="#FFF" />
      </Pressable>

      {plannedToast && (
        <View
          pointerEvents="none"
          style={[
            styles.planToast,
            {
              top: insets.top + spacing.sm,
              backgroundColor: colors.accent,
            },
          ]}
        >
          <Text style={styles.planToastText}>{plannedToast}</Text>
        </View>
      )}

      <PlanRecipeSheet
        visible={planSheetRecipe != null}
        recipe={planSheetRecipe}
        defaultPortions={preferences.defaultPortionSize}
        pantryItems={pantryItems}
        colors={colors}
        t={t}
        onCancel={() => setPlanSheetRecipe(null)}
        onConfirm={handlePlanConfirm}
      />
    </View>
  );
}

// ─── RecipePane — one full recipe page ────────────────────────────────
//
// A practical cook-&-shop tool, not a recipe magazine. One continuous scroll
// with a fixed section order so "Was habe ich? Was ist im Angebot? Was fehlt?
// Was kostet es?" is answered at a glance, over a sticky bottom CTA that always
// states the cost + the one main action.

interface RecipePaneProps {
  recipe: Recipe;
  colors: ThemeColors;
  insets: EdgeInsets;
  t: TFunc;
  pantryItems: PantryItem[];
  isFavorite: boolean;
  onToggleFavorite: () => void;
  /** Open the "Zum Wochenplan" sheet for this recipe (active pane only). */
  onPlanRecipe?: () => void;
  /** Active pane wires the deck's scroll ref + handler. Inactive panes
   *  render statically (scroll disabled, gestures off). */
  isActive: boolean;
  scrollRef?: React.MutableRefObject<Animated.ScrollView | null>;
  scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
}

function RecipePane({
  recipe,
  colors,
  insets,
  t,
  pantryItems,
  isFavorite,
  onToggleFavorite,
  onPlanRecipe,
  isActive,
  scrollRef,
  scrollHandler,
}: RecipePaneProps) {
  const dark = useColorScheme() === 'dark';
  const { hasFeature } = useSubscription();
  const trackingEnabled = hasFeature('diet_tracking');
  const [comments, setComments] = useState<RecipeComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [cookingLogPending, setCookingLogPending] = useState(false);
  const [cooked, setCooked] = useState(false);
  const [trackPending, setTrackPending] = useState(false);
  const [trackToast, setTrackToast] = useState(false);

  // Redesign state.
  const [portions, setPortions] = useState(recipe.servings);
  const [checkSteps, setCheckSteps] = useState(false);
  const [doneSteps, setDoneSteps] = useState<Record<number, boolean>>({});
  const [addState, setAddState] = useState<'idle' | 'pending' | 'done'>('idle');
  const [addedOffers, setAddedOffers] = useState<Record<string, boolean>>({});
  const [dealIngredient, setDealIngredient] = useState<RecipeIngredient | null>(null);

  // Deal validity is evaluated against a single timestamp per pane mount, so a
  // deal can't appear to expire mid-scroll.
  const nowRef = useRef(new Date());

  const internalScrollRef = useRef<Animated.ScrollView | null>(null);
  const effectiveScrollRef = scrollRef ?? internalScrollRef;

  // Pane state reset when the slot recycles to a different recipe (after a
  // deck commit). Without this, the user would land on a fresh recipe still
  // showing the previous one's portions / checked steps / sheets.
  useEffect(() => {
    setPortions(recipe.servings);
    setCheckSteps(false);
    setDoneSteps({});
    setAddState('idle');
    setAddedOffers({});
    setDealIngredient(null);
    setAddOpen(false);
    setCooked(false);
    nowRef.current = new Date();
    effectiveScrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [recipe.id, recipe.servings, effectiveScrollRef]);

  // Comments per recipe. Fires for all panes — including the off-screen
  // neighbours — so swiping into a neighbour has its comments ready. The
  // request is a single SELECT, the cost is acceptable.
  useEffect(() => {
    let cancelled = false;
    setCommentsLoading(true);
    fetchCommentsForRecipe(recipe.id)
      .then((rows) => {
        if (!cancelled) setComments(rows);
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn(
            '[RecipeDetailScreen] fetchComments failed:',
            (error as Error).message,
          );
          setComments([]);
        }
      })
      .finally(() => {
        if (!cancelled) setCommentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recipe.id]);

  // ── Derived shop state (pure, honest — see utils/recipeShop) ──
  const summary: RecipeShopSummary = useMemo(
    () =>
      summarizeRecipeShop(recipe.ingredients, pantryItems, {
        portions,
        baseServings: recipe.servings,
        now: nowRef.current,
      }),
    [recipe.ingredients, recipe.servings, pantryItems, portions],
  );
  const statuses = useMemo(() => {
    const map = new Map<string, DetailIngredientStatus>();
    for (const ing of recipe.ingredients) {
      map.set(ing.id, classifyDetailIngredient(ing, pantryItems, nowRef.current));
    }
    return map;
  }, [recipe.ingredients, pantryItems]);
  const offers = useMemo(
    () => selectRecipeOffers(recipe.ingredients, pantryItems, nowRef.current),
    [recipe.ingredients, pantryItems],
  );

  const factor = summary.factor;
  const allPantry = summary.deal === 0 && summary.missing === 0;
  const buyCount = summary.deal + summary.missing;

  const handleMarkCooked = () => {
    Alert.alert(
      t('cheffity.detail.markCookedTitle'),
      t('cheffity.detail.markCookedConfirm', { name: recipe.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('cheffity.detail.markCookedYes'),
          onPress: async () => {
            setCookingLogPending(true);
            try {
              await logCookedRecipe({ recipeId: recipe.id });
              setCooked(true);
            } catch (e) {
              Alert.alert(t('common.error'), (e as Error).message);
            } finally {
              setCookingLogPending(false);
            }
          },
        },
      ],
    );
  };

  // Log one serving of this recipe as eaten today. Separate from "cooked":
  // this feeds the nutrition tracker, cooked stays a cooking signal.
  const handleLogToTracking = async () => {
    setTrackPending(true);
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const category =
        recipe.mealType === 'breakfast' ||
        recipe.mealType === 'lunch' ||
        recipe.mealType === 'dinner'
          ? recipe.mealType
          : 'snack';
      await logRecipeAsMeal({
        date: today,
        category,
        recipeId: recipe.id,
        recipeName: recipe.name,
        portions: 1,
        caloriesPerServing: recipe.nutritionPerServing?.calories,
        proteinPerServing: recipe.nutritionPerServing?.protein,
        carbsPerServing: recipe.nutritionPerServing?.carbs,
        fatPerServing: recipe.nutritionPerServing?.fat,
      });
      setTrackToast(true);
      setTimeout(() => setTrackToast(false), 2500);
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
    } finally {
      setTrackPending(false);
    }
  };

  const handleSubmitComment = async (rating: number, text: string) => {
    const created = await submitComment({
      recipeId: recipe.id,
      rating,
      text,
    });
    setComments((prev) => [created, ...prev]);
  };

  // "Zur Liste" / sticky CTA: add everything NOT covered by the pantry (deal +
  // missing), scaled by the chosen portions. buildPlanShoppingItems skips
  // pantry-covered + unclear, so the count and the rows added stay in sync.
  const handleAddMissing = async () => {
    if (addState !== 'idle') return;
    setAddState('pending');
    try {
      const items = buildPlanShoppingItems(recipe.ingredients, pantryItems, {
        recipeId: recipe.id,
        portionRatio: factor,
      });
      await Promise.all(
        items.map((item) =>
          addShoppingItem({
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            recipeId: item.recipeId,
            dealId: item.dealId,
            storeName: item.storeName,
            price: item.price,
            isManual: item.isManual,
          }).catch((e) =>
            console.warn(
              '[RecipeDetailScreen] addShoppingItem failed for',
              item.name,
              ':',
              (e as Error).message,
            ),
          ),
        ),
      );
      setAddState('done');
      // Auto-reset so re-opening the same recipe doesn't lock the button.
      setTimeout(() => setAddState('idle'), 2500);
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
      setAddState('idle');
    }
  };

  // Add exactly one offer (its concrete deal) straight from its card.
  const handleAddOffer = async (ing: RecipeIngredient) => {
    if (addedOffers[ing.id]) return;
    setAddedOffers((prev) => ({ ...prev, [ing.id]: true }));
    try {
      await addShoppingItem(buildIngredientDealShoppingItem(ing, recipe.id));
    } catch (e) {
      console.warn('[RecipeDetailScreen] addShoppingItem (offer) failed:', (e as Error).message);
      setAddedOffers((prev) => ({ ...prev, [ing.id]: false }));
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <Animated.ScrollView
        ref={effectiveScrollRef}
        style={styles.fill}
        showsVerticalScrollIndicator={false}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        // Inactive panes are below the viewport / pointer-events:none.
        // Disabling scroll on them avoids the off-screen ScrollView ever
        // grabbing touches if the user somehow lands on it.
        scrollEnabled={isActive}
        bounces={isActive}
        contentContainerStyle={{ paddingBottom: STICKY_BAR_CLEARANCE + insets.bottom }}
      >
        {/* Hero illustration — gradient placeholder, no real photo needed. */}
        <View style={styles.imageWrap}>
          {recipe.imageUrl ? (
            <Image source={{ uri: recipe.imageUrl }} style={styles.image} />
          ) : (
            <View style={styles.image}>
              <RecipeIllustration recipeId={recipe.id} />
            </View>
          )}
          <LinearGradient
            colors={['rgba(0,0,0,0)', colors.background]}
            locations={[0, 1]}
            style={styles.heroGradient}
            pointerEvents="none"
          />
          {/* Heart stays with the hero — low-frequency action, fine if
              it disappears on scroll. Back button is at the deck level. */}
          <Pressable
            onPress={onToggleFavorite}
            style={[
              styles.cornerButton,
              { top: insets.top + spacing.sm, right: spacing.md },
            ]}
            hitSlop={8}
          >
            <Icon
              name="heart"
              size={20}
              color={isFavorite ? '#EF4444' : '#FFF'}
              active={isFavorite}
            />
          </Pressable>
        </View>

        {/* 1 · Title + intro + meta + tags */}
        <View style={styles.titleBlock}>
          <Text style={[styles.dishName, { color: colors.text }]} numberOfLines={3}>
            {recipe.name}
          </Text>
          {recipe.introText ? (
            <Text style={[styles.intro, { color: colors.textSecondary }]}>
              {recipe.introText}
            </Text>
          ) : null}
          <View style={styles.metaRow}>
            <MetaItem icon="clock" colors={colors}>
              {t('cheffity.cookTime', { minutes: recipe.cookTimeMinutes })}
            </MetaItem>
            <MetaItem icon="flame" colors={colors}>
              {t(`cheffity.difficulty.${recipe.difficulty}`)}
            </MetaItem>
            <MetaItem icon="profile" colors={colors}>
              {t('cheffity.detail.portionsValue', { portions })}
            </MetaItem>
            {recipe.nutritionPerServing?.calories != null && (
              <MetaItem icon="sparkle" colors={colors}>
                {`${recipe.nutritionPerServing.calories} kcal`}
              </MetaItem>
            )}
          </View>
          <RecipeTaxonomyChips recipe={recipe} colors={colors} t={t} />
        </View>

        {/* 2 · Sofort-Zusammenfassung — the heart of the screen */}
        <SummaryBand colors={colors} dark={dark} summary={summary} t={t} />

        {/* 3 · Portionen-Stepper — scales amounts + costs live */}
        <PortionStepper colors={colors} value={portions} onChange={setPortions} disabled={!isActive} t={t} />

        {/* 4 · Hauptaktionen */}
        <View style={styles.primaryActions}>
          <Pressable
            style={[styles.actionBtn, styles.actionSecondary, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => onPlanRecipe?.()}
            disabled={!isActive}
          >
            <Icon name="plan" size={16} color={colors.text} />
            <Text style={[styles.actionLabel, { color: colors.text }]}>
              {t('cheffity.detail.planWeekAction')}
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.actionBtn,
              {
                backgroundColor: addState === 'done' ? colors.success : colors.primary,
                opacity: addState === 'pending' ? 0.6 : allPantry ? 0.45 : 1,
              },
            ]}
            onPress={handleAddMissing}
            disabled={!isActive || addState !== 'idle' || allPantry}
          >
            <Icon name={addState === 'done' ? 'check' : 'cart-plus'} size={16} color="#FFF" active={addState !== 'done'} strokeWidth={addState === 'done' ? 2.6 : 1.8} />
            <Text style={[styles.actionLabel, { color: '#FFF' }]}>
              {addState === 'done' ? t('cheffity.detail.missingAddedSuccess') : t('cheffity.detail.toListAction')}
            </Text>
          </Pressable>
        </View>

        {/* 5 · Im Angebot für dieses Rezept */}
        <Section
          colors={colors}
          title={t('cheffity.detail.sectionOffers')}
          right={
            offers.length > 0 ? (
              <StatusPill status="deal" colors={colors} dark={dark} t={t} label={String(offers.length)} icon="tag" />
            ) : null
          }
        >
          {offers.length > 0 ? (
            <View style={{ gap: 9 }}>
              {offers.map((ing) => (
                <OfferCard
                  key={ing.id}
                  ingredient={ing}
                  colors={colors}
                  t={t}
                  added={!!addedOffers[ing.id]}
                  onOpen={() => setDealIngredient(ing)}
                  onAdd={() => handleAddOffer(ing)}
                  disabled={!isActive}
                />
              ))}
            </View>
          ) : summary.hasExpiredDeals ? (
            <NoticeCard
              colors={colors}
              tone="warning"
              icon="clock"
              title={t('cheffity.detail.offersExpiredTitle')}
              body={t('cheffity.detail.offersExpiredBody')}
            />
          ) : (
            <NoticeCard
              colors={colors}
              tone="muted"
              icon="tag"
              title={t('cheffity.detail.offersEmptyTitle')}
              body={t('cheffity.detail.offersEmptyBody')}
            />
          )}
        </Section>

        {/* 6 · Zutatenliste mit Status */}
        <Section
          colors={colors}
          title={t('cheffity.ingredients')}
          right={
            <Text style={[styles.sectionRightText, { color: colors.textTertiary }]}>
              {t('cheffity.detail.ingredientsCountMeta', { total: recipe.ingredients.length, portions })}
            </Text>
          }
        >
          <View>
            {recipe.ingredients.map((ing, i) => (
              <IngredientStatusRow
                key={ing.id}
                ingredient={ing}
                status={statuses.get(ing.id) ?? 'missing'}
                factor={factor}
                first={i === 0}
                colors={colors}
                dark={dark}
                t={t}
                onPress={
                  ingredientHasConcreteDeal(ing) && (statuses.get(ing.id) === 'deal')
                    ? () => setDealIngredient(ing)
                    : undefined
                }
              />
            ))}
          </View>
        </Section>

        {/* 7 · Zubereitung */}
        <Section
          colors={colors}
          title={t('cheffity.instructions')}
          right={
            recipe.instructions.length > 0 ? (
              <Pressable
                onPress={() => setCheckSteps((v) => !v)}
                disabled={!isActive}
                hitSlop={8}
                style={styles.stepToggle}
              >
                <Icon name={checkSteps ? 'check' : 'sliders'} size={14} color={checkSteps ? colors.accent : colors.primary} />
                <Text style={[styles.stepToggleText, { color: checkSteps ? colors.accent : colors.primary }]}>
                  {checkSteps ? t('cheffity.detail.stepsToggleOn') : t('cheffity.detail.stepsToggle')}
                </Text>
              </Pressable>
            ) : null
          }
        >
          <View>
            {recipe.instructions.map((step, i) => (
              <StepRow
                key={i}
                n={i + 1}
                text={step}
                checkable={checkSteps}
                done={!!doneSteps[i]}
                colors={colors}
                onToggle={() => setDoneSteps((p) => ({ ...p, [i]: !p[i] }))}
              />
            ))}
          </View>
        </Section>

        {/* 8 · Nährwerte */}
        <Section
          colors={colors}
          title={t('cheffity.detail.sectionNutrition')}
          right={
            recipe.nutritionPerServing ? (
              <Text style={[styles.sectionRightText, { color: colors.textTertiary }]}>
                {t('cheffity.detail.perServing')}
              </Text>
            ) : null
          }
        >
          <NutritionBlock nutrition={recipe.nutritionPerServing} colors={colors} t={t} />
        </Section>

        {/* 9 · Quelle & Mehr — quiet secondary zone */}
        <Section colors={colors} title={t('cheffity.detail.sectionMore')}>
          <View style={{ gap: 10 }}>
            <ProvenanceRow recipe={recipe} colors={colors} t={t} />
            {shouldShowAiSafetyNotice(recipe) && (
              <NoticeCard
                colors={colors}
                tone="warning"
                icon="sparkle"
                title={t('cheffity.detail.aiNoticeTitle')}
                body={t('cheffity.detail.aiNoticeBody')}
                footer={recipe.safetyNotes ?? undefined}
              />
            )}
            <CommentsBlock
              recipe={recipe}
              comments={comments}
              loading={commentsLoading}
              colors={colors}
              t={t}
              onAdd={isActive ? () => setAddOpen(true) : undefined}
            />
            <QuietRow
              colors={colors}
              icon={cooked ? 'check' : 'cheffity-hat'}
              title={cooked ? t('cheffity.detail.cookedTitleDone') : t('cheffity.detail.cookedTitle')}
              sub={cooked ? t('cheffity.detail.markCookedSuccess') : t('cheffity.detail.cookedSub')}
              right={
                cooked ? (
                  <StatusPill status="deal" colors={colors} dark={dark} t={t} label={t('cheffity.detail.cookedPill')} icon="check" />
                ) : (
                  <Icon name="chevron-right" size={16} color={colors.textTertiary} />
                )
              }
              onPress={isActive && !cookingLogPending ? handleMarkCooked : undefined}
            />
            {trackingEnabled && (
              <QuietRow
                colors={colors}
                icon="leaf"
                title={t('diet.logFromRecipe')}
                sub={t('cheffity.detail.dietDiarySub')}
                right={<Icon name="chevron-right" size={16} color={colors.textTertiary} />}
                onPress={isActive && !trackPending ? handleLogToTracking : undefined}
              />
            )}
            {trackToast && (
              <View style={[styles.inlineToast, { backgroundColor: colors.primaryLight, borderColor: colors.primary }]}>
                <Text style={[typography.bodySmall, { color: colors.primary, textAlign: 'center' }]}>
                  {t('diet.loggedToTracking')}
                </Text>
              </View>
            )}
          </View>
        </Section>
      </Animated.ScrollView>

      {/* Sticky bottom CTA — states cost + the one main action (active pane). */}
      {isActive && (
        <View
          style={[
            styles.stickyBar,
            {
              backgroundColor: colors.surfaceElevated,
              borderTopColor: colors.borderLight,
              paddingBottom: insets.bottom + 12,
            },
          ]}
        >
          <View style={styles.stickyCost}>
            <Text style={[styles.stickyCostLabel, { color: colors.textTertiary }]}>
              {allPantry ? t('cheffity.detail.stickyReady') : t('cheffity.detail.stickyEstimated')}
            </Text>
            <Text
              style={[styles.stickyCostValue, { color: allPantry ? colors.accent : colors.text }]}
              numberOfLines={1}
            >
              {allPantry
                ? t('cheffity.detail.stickyAllReady')
                : summary.estimatedCost != null
                  ? t('cheffity.detail.approxCost', { amount: eur(summary.estimatedCost) })
                  : '—'}
            </Text>
          </View>
          <Pressable
            style={[
              styles.stickyCta,
              {
                backgroundColor: addState === 'done' ? colors.success : colors.primary,
                opacity: addState === 'pending' ? 0.6 : 1,
              },
            ]}
            onPress={allPantry ? () => onPlanRecipe?.() : handleAddMissing}
            disabled={!allPantry && addState !== 'idle'}
          >
            <Icon
              name={allPantry ? 'plan' : addState === 'done' ? 'check' : 'cart-plus'}
              size={18}
              color="#FFF"
              active={!(allPantry === false && addState === 'done')}
              strokeWidth={addState === 'done' && !allPantry ? 2.6 : 1.8}
            />
            <Text style={styles.stickyCtaText}>
              {allPantry
                ? t('cheffity.detail.planWeekAction')
                : addState === 'done'
                  ? t('cheffity.detail.missingAddedSuccess')
                  : buyCount > 0
                    ? t('cheffity.detail.buyBarCtaCount', { n: buyCount })
                    : t('cheffity.detail.buyBarCta')}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Concrete-deal sheet — opened from an offer card or a deal row. */}
      <IngredientDealSheet
        visible={dealIngredient != null}
        ingredient={dealIngredient}
        recipeId={recipe.id}
        colors={colors}
        t={t}
        onClose={() => setDealIngredient(null)}
      />

      {/* AddCommentModal lives per-pane so its open-state is tied to the
          recipe. The reset effect above clears addOpen on slot recycle. */}
      <AddCommentModal
        visible={isActive && addOpen}
        recipeName={recipe.name}
        onClose={() => setAddOpen(false)}
        onSubmit={handleSubmitComment}
      />
    </View>
  );
}

// ─── German number helpers ──────────────────────────────────────────────

/** "2.99" → "2,99" (no currency symbol). */
function eur(n: number): string {
  return n.toFixed(2).replace('.', ',');
}

/** Integer stays bare; decimals use a German comma ("2.5" → "2,5"). */
function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

// ─── Small building blocks ───────────────────────────────────────────────

function MetaItem({
  icon,
  colors,
  children,
}: {
  icon: IconName;
  colors: ThemeColors;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.metaItem}>
      <Icon name={icon} size={13} color={colors.textSecondary} />
      <Text style={[styles.metaItemText, { color: colors.textSecondary }]}>{children}</Text>
    </View>
  );
}

function Section({
  colors,
  title,
  right,
  children,
}: {
  colors: ThemeColors;
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

type PillStatus = DetailIngredientStatus;

const STATUS_META: Record<
  PillStatus,
  { tone: 'neutral' | 'accent' | 'warning'; icon: IconName; labelKey: string }
> = {
  pantry: { tone: 'neutral', icon: 'pantry', labelKey: 'cheffity.detail.statusInPantry' },
  deal: { tone: 'accent', icon: 'tag', labelKey: 'cheffity.detail.statusOnDeal' },
  missing: { tone: 'warning', icon: 'cart-plus', labelKey: 'cheffity.detail.statusMissing' },
  unclear: { tone: 'neutral', icon: 'info', labelKey: 'cheffity.detail.statusUnclear' },
};

function statusDotColor(status: PillStatus, colors: ThemeColors, dark: boolean): string {
  switch (status) {
    case 'deal':
      return colors.accent;
    case 'missing':
      return colors.warning;
    case 'unclear':
      return dark ? '#7C92B5' : '#94A3B8';
    default:
      return colors.textTertiary; // pantry
  }
}

function StatusPill({
  status,
  colors,
  dark,
  t,
  label,
  icon,
}: {
  status: PillStatus;
  colors: ThemeColors;
  dark: boolean;
  t: TFunc;
  /** Override the default status label (e.g. an offer count). */
  label?: string;
  icon?: IconName;
}) {
  const meta = STATUS_META[status];
  const tone = meta.tone;
  const bg = tone === 'accent' ? colors.accentLight : tone === 'warning' ? colors.warningLight : colors.surface;
  const fg = tone === 'accent' ? colors.accent : tone === 'warning' ? colors.warning : colors.textSecondary;
  const border = tone === 'neutral' ? colors.borderLight : 'transparent';
  void dark;
  return (
    <View style={[styles.pill, { backgroundColor: bg, borderColor: border }]}>
      <Icon name={icon ?? meta.icon} size={11} color={fg} />
      <Text style={[styles.pillText, { color: fg }]}>{label ?? t(meta.labelKey)}</Text>
    </View>
  );
}

function NoticeCard({
  colors,
  tone,
  icon,
  title,
  body,
  footer,
}: {
  colors: ThemeColors;
  tone: 'warning' | 'muted';
  icon: IconName;
  title: string;
  body: string;
  footer?: string;
}) {
  const warning = tone === 'warning';
  return (
    <View
      style={[
        styles.notice,
        warning
          ? { backgroundColor: colors.warningLight, borderColor: colors.warning + '55' }
          : { backgroundColor: colors.surface, borderColor: colors.borderLight },
      ]}
    >
      <View style={styles.noticeHead}>
        <Icon name={icon} size={18} color={warning ? colors.warning : colors.textTertiary} active={warning} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.noticeTitle, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.noticeBody, { color: colors.textSecondary }]}>{body}</Text>
        </View>
      </View>
      {footer ? (
        <Text style={[styles.noticeFooter, { color: colors.textSecondary, borderTopColor: colors.border }]}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

// ─── Summary band ─────────────────────────────────────────────────────────

function SummaryBand({
  colors,
  dark,
  summary,
  t,
}: {
  colors: ThemeColors;
  dark: boolean;
  summary: RecipeShopSummary;
  t: TFunc;
}) {
  const allPantry = summary.deal === 0 && summary.missing === 0;
  const seg = (n: number, label: string, status: PillStatus) => (
    <View style={styles.summarySeg}>
      <View style={styles.summarySegTop}>
        <View style={[styles.summaryDot, { backgroundColor: statusDotColor(status, colors, dark) }]} />
        <Text style={[styles.summaryNum, { color: colors.text }]}>{n}</Text>
      </View>
      <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
  return (
    <View style={styles.summaryWrap}>
      <View
        style={[
          styles.summaryCard,
          {
            backgroundColor: allPantry ? colors.accentLight : colors.surfaceElevated,
            borderColor: allPantry ? colors.accent + '55' : colors.border,
          },
        ]}
      >
        <View style={styles.summaryRow}>
          {seg(summary.pantry, t('cheffity.detail.statusInPantry'), 'pantry')}
          <View style={[styles.summaryDivider, { backgroundColor: colors.borderLight }]} />
          {seg(summary.deal, t('cheffity.detail.statusOnDeal'), 'deal')}
          <View style={[styles.summaryDivider, { backgroundColor: colors.borderLight }]} />
          {seg(summary.missing, t('cheffity.detail.statusMissing'), 'missing')}
        </View>
        <View
          style={[
            styles.summaryFooter,
            {
              borderTopColor: allPantry ? colors.accent + '44' : colors.borderLight,
              backgroundColor: allPantry ? 'transparent' : colors.surface,
            },
          ]}
        >
          <View style={styles.summaryFooterLeft}>
            <Icon
              name={allPantry ? 'check' : 'cart-plus'}
              size={15}
              color={allPantry ? colors.accent : colors.textTertiary}
              active={allPantry}
              strokeWidth={allPantry ? 2.4 : 1.8}
            />
            <Text style={[styles.summaryFooterLabel, { color: colors.textSecondary }]} numberOfLines={1}>
              {allPantry ? t('cheffity.detail.pantryReadyTitle') : t('cheffity.detail.estimatedCostLabel')}
            </Text>
          </View>
          <Text style={[styles.summaryCost, { color: allPantry ? colors.accent : colors.text }]} numberOfLines={1}>
            {allPantry
              ? formatEuro(0)
              : summary.estimatedCost != null
                ? t('cheffity.detail.approxCost', { amount: eur(summary.estimatedCost) })
                : '—'}
          </Text>
        </View>
      </View>
      {summary.unclear > 0 && (
        <View style={styles.unclearNote}>
          <View style={[styles.summaryDot, { backgroundColor: statusDotColor('unclear', colors, dark) }]} />
          <Text style={[styles.unclearNoteText, { color: colors.textSecondary }]}>
            {t('cheffity.detail.summaryUnclearNote', { count: summary.unclear })}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Portion stepper ───────────────────────────────────────────────────────

function PortionStepper({
  colors,
  value,
  onChange,
  disabled,
  t,
}: {
  colors: ThemeColors;
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  t: TFunc;
}) {
  const stepBtn = (icon: IconName, fn: () => void, off: boolean) => (
    <Pressable
      onPress={off || disabled ? undefined : fn}
      disabled={off || disabled}
      style={[styles.stepBtn, { backgroundColor: colors.surfaceElevated, borderColor: colors.border, opacity: off ? 0.4 : 1 }]}
      hitSlop={6}
    >
      <Icon name={icon} size={16} color={colors.text} />
    </Pressable>
  );
  return (
    <View style={styles.stepperWrap}>
      <View style={[styles.stepperCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
        <View style={styles.stepperLabelRow}>
          <Icon name="profile" size={17} color={colors.textSecondary} />
          <Text style={[styles.stepperLabel, { color: colors.text }]}>{t('cheffity.detail.portionsLabel')}</Text>
        </View>
        <View style={styles.stepperControls}>
          {stepBtn('minus', () => onChange(Math.max(1, value - 1)), value <= 1)}
          <Text style={[styles.stepperValue, { color: colors.text }]}>{value}</Text>
          {stepBtn('plus', () => onChange(Math.min(12, value + 1)), value >= 12)}
        </View>
      </View>
    </View>
  );
}

// ─── Offer card ─────────────────────────────────────────────────────────────

function OfferCard({
  ingredient,
  colors,
  t,
  added,
  onOpen,
  onAdd,
  disabled,
}: {
  ingredient: RecipeIngredient;
  colors: ThemeColors;
  t: TFunc;
  added: boolean;
  onOpen: () => void;
  onAdd: () => void;
  disabled?: boolean;
}) {
  const productName =
    ingredient.dealName && ingredient.dealName.trim().length > 0 ? ingredient.dealName : ingredient.name;
  const seedKey = ingredient.dealId || ingredient.dealName || ingredient.name;
  const validTo = formatShortDate(ingredient.dealValidTo);
  const hasOriginal =
    ingredient.dealOriginalPrice != null &&
    ingredient.dealPrice != null &&
    ingredient.dealOriginalPrice > ingredient.dealPrice;
  return (
    <Pressable
      onPress={disabled ? undefined : onOpen}
      style={[styles.offerCard, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
      accessibilityRole="button"
      accessibilityLabel={t('cheffity.detail.dealSheet.openA11y', { name: ingredient.name })}
    >
      <ProductThumb
        imageUrl={ingredient.dealImageUrl}
        seed={thumbSeed(seedKey)}
        tint={thumbTint(seedKey)}
        size={56}
        radius={12}
      />
      <View style={styles.offerBody}>
        <Text style={[styles.offerName, { color: colors.text }]} numberOfLines={1}>
          {productName}
        </Text>
        <View style={styles.offerMeta}>
          {ingredient.dealStoreName ? (
            <View style={[styles.storeChip, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
              <Text style={[styles.storeChipText, { color: colors.text }]} numberOfLines={1}>
                {ingredient.dealStoreName}
              </Text>
            </View>
          ) : null}
          {validTo ? (
            <View style={styles.offerValidity}>
              <Icon name="clock" size={11} color={colors.textTertiary} />
              <Text style={[styles.offerValidityText, { color: colors.textTertiary }]} numberOfLines={1}>
                {t('cheffity.detail.dealSheet.validUntil', { date: validTo })}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.offerPrices}>
        <View style={styles.offerPriceRow}>
          {hasOriginal ? (
            <Text style={[styles.offerOldPrice, { color: colors.textTertiary }]}>
              {formatEuro(ingredient.dealOriginalPrice as number)}
            </Text>
          ) : null}
          <Text style={[styles.offerPrice, { color: colors.text }]}>
            {ingredient.dealPrice != null ? formatEuro(ingredient.dealPrice) : '—'}
          </Text>
        </View>
        {ingredient.discountPercent != null && ingredient.discountPercent > 0 ? (
          <Text style={[styles.offerDiscount, { color: colors.accent }]}>-{ingredient.discountPercent}%</Text>
        ) : null}
      </View>
      <Pressable
        onPress={disabled ? undefined : onAdd}
        disabled={disabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={t('cheffity.detail.toListAction')}
        style={[styles.offerAddBtn, { backgroundColor: added ? colors.accentLight : colors.primaryLight }]}
      >
        <Icon
          name={added ? 'check' : 'cart-plus'}
          size={18}
          color={added ? colors.accent : colors.primary}
          active={added}
          strokeWidth={added ? 2.4 : 1.8}
        />
      </Pressable>
    </Pressable>
  );
}

// ─── Ingredient status row ───────────────────────────────────────────────────

function IngredientStatusRow({
  ingredient,
  status,
  factor,
  first,
  colors,
  dark,
  t,
  onPress,
}: {
  ingredient: RecipeIngredient;
  status: PillStatus;
  factor: number;
  first: boolean;
  colors: ThemeColors;
  dark: boolean;
  t: TFunc;
  onPress?: () => void;
}) {
  const scaled = scaleIngredientAmount(ingredient.amount, factor);
  const amountText = scaled != null ? `${formatAmount(scaled)} ${ingredient.unit}`.trim() : null;
  const tappable = onPress != null;
  const showPrice = status === 'deal' && ingredient.dealPrice != null;

  const body = (
    <>
      <View style={[styles.ingDot, { backgroundColor: statusDotColor(status, colors, dark) }]} />
      <View style={styles.ingInfo}>
        <Text style={[styles.ingName, { color: colors.text }]} numberOfLines={2}>
          {ingredient.name}
        </Text>
        {amountText ? (
          <Text style={[styles.ingAmount, { color: colors.textTertiary }]}>{amountText}</Text>
        ) : status === 'unclear' ? (
          <Text style={[styles.ingAmount, { color: colors.warning }]}>{t('cheffity.detail.unclearHint')}</Text>
        ) : null}
      </View>
      {showPrice ? (
        <Text style={[styles.ingPrice, { color: colors.text }]}>
          {formatEuro(ingredient.dealPrice as number)}
        </Text>
      ) : null}
      <StatusPill status={status} colors={colors} dark={dark} t={t} />
      {tappable ? <Icon name="chevron-right" size={16} color={colors.textTertiary} /> : null}
    </>
  );

  if (tappable) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.ingRow,
          { borderTopColor: colors.borderLight, borderTopWidth: first ? 0 : 1, opacity: pressed ? 0.6 : 1 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={t('cheffity.detail.dealSheet.openA11y', { name: ingredient.name })}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View style={[styles.ingRow, { borderTopColor: colors.borderLight, borderTopWidth: first ? 0 : 1 }]}>{body}</View>
  );
}

// ─── Step row ────────────────────────────────────────────────────────────────

function StepRow({
  n,
  text,
  checkable,
  done,
  colors,
  onToggle,
}: {
  n: number;
  text: string;
  checkable: boolean;
  done: boolean;
  colors: ThemeColors;
  onToggle: () => void;
}) {
  const rowStyle = [
    styles.stepRow,
    { borderTopColor: colors.borderLight, borderTopWidth: n === 1 ? 0 : 1 },
  ];
  const inner = (
    <>
      {checkable ? (
        <View
          style={[
            styles.stepCheck,
            { borderColor: done ? colors.accent : colors.border, backgroundColor: done ? colors.accent : 'transparent' },
          ]}
        >
          {done ? (
            <Icon name="check" size={15} color="#FFF" strokeWidth={2.6} />
          ) : (
            <Text style={[styles.stepNum, { color: colors.textTertiary }]}>{n}</Text>
          )}
        </View>
      ) : (
        <View style={[styles.stepCircle, { backgroundColor: colors.primaryLight }]}>
          <Text style={[styles.stepNum, { color: colors.primary }]}>{n}</Text>
        </View>
      )}
      <Text
        style={[
          styles.stepText,
          { color: done ? colors.textTertiary : colors.textSecondary, textDecorationLine: done ? 'line-through' : 'none' },
        ]}
      >
        {text}
      </Text>
    </>
  );
  return checkable ? (
    <Pressable onPress={onToggle} style={rowStyle}>
      {inner}
    </Pressable>
  ) : (
    <View style={rowStyle}>{inner}</View>
  );
}

// ─── Nutrition ────────────────────────────────────────────────────────────────

function NutritionBlock({
  nutrition,
  colors,
  t,
}: {
  nutrition: Recipe['nutritionPerServing'];
  colors: ThemeColors;
  t: TFunc;
}) {
  if (!nutrition || (nutrition.calories == null && nutrition.protein == null && nutrition.carbs == null && nutrition.fat == null)) {
    return (
      <NoticeCard
        colors={colors}
        tone="muted"
        icon="info"
        title={t('cheffity.detail.nutritionEmptyTitle')}
        body={t('cheffity.detail.nutritionEmptyBody')}
      />
    );
  }
  const cells: Array<{ value?: number; unit: string; label: string }> = [
    { value: nutrition.calories, unit: t('cheffity.detail.kcal'), label: t('cheffity.detail.kcal') },
    { value: nutrition.protein, unit: 'g', label: t('cheffity.detail.protein') },
    { value: nutrition.carbs, unit: 'g', label: t('cheffity.detail.carbs') },
    { value: nutrition.fat, unit: 'g', label: t('cheffity.detail.fat') },
  ];
  return (
    <View style={styles.nutritionGrid}>
      {cells.map((c, i) => (
        <View key={i} style={[styles.nutritionCell, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <Text style={[styles.nutritionValue, { color: colors.text }]}>{c.value != null ? c.value : '—'}</Text>
          <Text style={[styles.nutritionUnit, { color: colors.textTertiary }]}>{c.unit}</Text>
          <Text style={[styles.nutritionLabel, { color: colors.textSecondary }]}>{c.label}</Text>
        </View>
      ))}
    </View>
  );
}

// ─── Quiet zone rows ─────────────────────────────────────────────────────────

function QuietRow({
  colors,
  icon,
  title,
  sub,
  right,
  onPress,
}: {
  colors: ThemeColors;
  icon: IconName;
  title: string;
  sub?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const rowStyle = [styles.quietRow, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }];
  const inner = (
    <>
      <View style={[styles.quietIcon, { backgroundColor: colors.surface }]}>
        <Icon name={icon} size={17} color={colors.textSecondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.quietTitle, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        {sub ? (
          <Text style={[styles.quietSub, { color: colors.textTertiary }]} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {right}
    </>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={rowStyle}>
      {inner}
    </Pressable>
  ) : (
    <View style={rowStyle}>{inner}</View>
  );
}

const SOURCE_LABEL_KEY: Record<Recipe['sourceType'], string> = {
  human_verified: 'cheffity.provenance.verified',
  public_domain_adapted: 'cheffity.provenance.publicDomain',
  ai_adapted: 'cheffity.provenance.aiAdapted',
  ai_generated: 'cheffity.provenance.aiGenerated',
};

function ProvenanceRow({
  recipe,
  colors,
  t,
}: {
  recipe: Recipe;
  colors: ThemeColors;
  t: TFunc;
}) {
  const hasSource = Boolean(recipe.sourceTitle || recipe.sourceAuthor || recipe.sourceUrl);
  const typeLabel = t(SOURCE_LABEL_KEY[recipe.sourceType] ?? 'cheffity.detail.sourceLabel');
  const title = hasSource
    ? recipe.sourceTitle
      ? `${typeLabel} · ${recipe.sourceTitle}`
      : typeLabel
    : t('cheffity.detail.sourceMissingTitle');

  const subParts: string[] = [];
  if (recipe.sourceAuthor) subParts.push(recipe.sourceAuthor);
  if (recipe.sourceYear) subParts.push(`(${recipe.sourceYear})`);
  if (recipe.sourceLicense) subParts.push(`${t('cheffity.detail.sourceLicensePrefix')} ${recipe.sourceLicense}`);
  const sub = hasSource
    ? subParts.join(' · ') || (recipe.sourceUrl ? t('cheffity.detail.sourceOpenLink') : undefined)
    : t('cheffity.detail.sourceMissingBody');

  const openUrl = recipe.sourceUrl
    ? () => {
        Linking.openURL(recipe.sourceUrl as string).catch(() => {
          // Silent: deep linking may fail on simulators / blocked schemes.
        });
      }
    : undefined;

  return (
    <QuietRow
      colors={colors}
      icon={hasSource ? 'sparkle' : 'info'}
      title={title}
      sub={sub}
      onPress={openUrl}
      right={
        recipe.aiNoticeRequired ? (
          <View style={[styles.pill, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
            <Icon name="info" size={11} color={colors.textSecondary} />
            <Text style={[styles.pillText, { color: colors.textSecondary }]}>{t('cheffity.detail.aiNoticeTitle')}</Text>
          </View>
        ) : recipe.sourceUrl ? (
          <Icon name="chevron-right" size={16} color={colors.textTertiary} />
        ) : null
      }
    />
  );
}

function CommentsBlock({
  recipe,
  comments,
  loading,
  colors,
  t,
  onAdd,
}: {
  recipe: Recipe;
  comments: RecipeComment[];
  loading: boolean;
  colors: ThemeColors;
  t: TFunc;
  onAdd?: () => void;
}) {
  const rating = recipe.rating ?? 0;
  const ratingCount = recipe.ratingCount ?? comments.length;
  const shown = comments.slice(0, INLINE_COMMENT_LIMIT);
  return (
    <View style={[styles.commentsCard, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
      <View style={styles.commentsHead}>
        <Icon name="star" size={17} color={colors.warning} active />
        <Text style={[styles.commentsRating, { color: colors.text }]}>{rating > 0 ? rating.toFixed(1) : '–'}</Text>
        <Text style={[styles.commentsRatingSub, { color: colors.textTertiary }]}>
          {`· ${t('cheffity.detail.commentsRatingCount', { count: ratingCount })}`}
        </Text>
      </View>
      {loading ? (
        <Text style={[styles.commentsEmpty, { color: colors.textTertiary, borderTopColor: colors.borderLight }]}>
          {t('common.loading')}
        </Text>
      ) : shown.length === 0 ? (
        <Text style={[styles.commentsEmpty, { color: colors.textTertiary, borderTopColor: colors.borderLight }]}>
          {t('cheffity.detail.noComments')}
        </Text>
      ) : (
        shown.map((cm) => {
          const stars = Math.round(cm.rating);
          return (
            <View key={cm.id} style={[styles.commentRow, { borderTopColor: colors.borderLight }]}>
              <View style={[styles.commentAvatar, { backgroundColor: colors.primaryLight }]}>
                <Text style={[styles.commentAvatarText, { color: colors.primary }]}>{cm.avatarInitials}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={styles.commentTop}>
                  <Text style={[styles.commentName, { color: colors.text }]} numberOfLines={1}>
                    {cm.username}
                  </Text>
                  <View style={styles.commentStars}>
                    {Array.from({ length: 5 }).map((_, k) => (
                      <Icon key={k} name="star" size={10} color={k < stars ? colors.warning : colors.border} active={k < stars} />
                    ))}
                  </View>
                </View>
                <Text style={[styles.commentText, { color: colors.textSecondary }]}>{cm.text}</Text>
              </View>
            </View>
          );
        })
      )}
      {onAdd ? (
        <Pressable onPress={onAdd} style={[styles.commentsCta, { borderTopColor: colors.borderLight }]}>
          <Text style={[styles.commentsCtaText, { color: colors.primary }]}>{t('cheffity.detail.addComment')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function RecipeTaxonomyChips({
  recipe,
  colors,
  t,
}: {
  recipe: Recipe;
  colors: ThemeColors;
  t: TFunc;
}) {
  // Diet flags first (most meaningful), then tags not already shown. Dedup
  // case-insensitively and cap so the row stays "dezent".
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of [...(recipe.dietFlags ?? []), ...(recipe.tags ?? [])]) {
    const key = raw.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(raw.trim());
    if (labels.length >= 4) break;
  }
  if (!recipe.cuisine && labels.length === 0) return null;

  return (
    <View style={styles.taxonomyRow}>
      {recipe.cuisine ? (
        <View style={[styles.cuisinePill, { backgroundColor: colors.primaryLight }]}>
          <Text style={[styles.cuisinePillText, { color: colors.primary }]}>
            {getCuisineLabel(normalizeCuisine(recipe.cuisine), t)}
          </Text>
        </View>
      ) : null}
      {labels.map((label) => (
        <View key={label} style={[styles.tagPill, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <Text style={[styles.tagPillText, { color: colors.textSecondary }]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  fill: { flex: 1 },
  container: { flex: 1 },

  // Each slot is absolutely positioned to fill the container; translateY
  // is what moves them relative to the viewport.
  paneLayer: {
    ...StyleSheet.absoluteFillObject,
  },

  imageWrap: { width: '100%', height: HEADER_IMAGE_HEIGHT, position: 'relative' },
  image: { width: '100%', height: '100%', overflow: 'hidden' },
  heroGradient: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 120 },
  cornerButton: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // 1 · Title block
  titleBlock: { paddingHorizontal: 20, paddingTop: spacing.sm, marginTop: -28 },
  dishName: { fontFamily: fontFamilies.displaySemibold, fontSize: 28, lineHeight: 32, letterSpacing: -0.6 },
  intro: { fontFamily: fontFamilies.regular, fontSize: 14, lineHeight: 20, marginTop: 8 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 13 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaItemText: { fontSize: 12.5, fontFamily: fontFamilies.semibold, letterSpacing: -0.1 },
  taxonomyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 12 },
  cuisinePill: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  cuisinePillText: { fontSize: 12.5, fontFamily: fontFamilies.bold },
  tagPill: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1 },
  tagPillText: { fontSize: 12, fontFamily: fontFamilies.medium },

  // Section scaffolding
  section: { paddingHorizontal: 20, paddingTop: 24 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 },
  sectionTitle: { fontFamily: fontFamilies.bold, fontSize: 12, letterSpacing: 0.4, textTransform: 'uppercase' },
  sectionRightText: { fontSize: 12, fontFamily: fontFamilies.semibold },

  // Pills
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillText: { fontSize: 11, fontFamily: fontFamilies.semibold, letterSpacing: -0.1 },

  // Summary band
  summaryWrap: { paddingHorizontal: 20, paddingTop: 16 },
  summaryCard: { borderWidth: 1, borderRadius: 18, overflow: 'hidden' },
  summaryRow: { flexDirection: 'row', alignItems: 'stretch', paddingVertical: 14, paddingHorizontal: 8 },
  summarySeg: { flex: 1, alignItems: 'center', gap: 4 },
  summarySegTop: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  summaryDot: { width: 8, height: 8, borderRadius: 4 },
  summaryNum: { fontFamily: fontFamilies.displayBold, fontSize: 19, letterSpacing: -0.4 },
  summaryLabel: { fontFamily: fontFamilies.semibold, fontSize: 10.5, letterSpacing: 0.1 },
  summaryDivider: { width: 1, marginVertical: 2 },
  summaryFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderTopWidth: 1,
  },
  summaryFooterLeft: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1, minWidth: 0 },
  summaryFooterLabel: { fontFamily: fontFamilies.semibold, fontSize: 13 },
  summaryCost: { fontFamily: fontFamilies.displayBold, fontSize: 18, letterSpacing: -0.4 },
  unclearNote: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 9, paddingLeft: 2 },
  unclearNoteText: { fontFamily: fontFamilies.semibold, fontSize: 12, flex: 1 },

  // Portion stepper
  stepperWrap: { paddingHorizontal: 20, paddingTop: 18 },
  stepperCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingLeft: 16,
    paddingRight: 12,
    borderWidth: 1,
    borderRadius: 14,
  },
  stepperLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  stepperLabel: { fontFamily: fontFamilies.bold, fontSize: 14 },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepperValue: { fontFamily: fontFamilies.displayBold, fontSize: 19, minWidth: 22, textAlign: 'center' },

  // Primary actions
  primaryActions: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingTop: 14 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 13,
    borderRadius: 12,
  },
  actionSecondary: { borderWidth: 1 },
  actionLabel: { fontFamily: fontFamilies.bold, fontSize: 14, letterSpacing: -0.1 },

  // Notice cards (empty / expired / ai)
  notice: { borderWidth: 1, borderRadius: 14, padding: 15 },
  noticeHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  noticeTitle: { fontFamily: fontFamilies.bold, fontSize: 13.5 },
  noticeBody: { fontFamily: fontFamilies.medium, fontSize: 12.5, marginTop: 1, lineHeight: 18 },
  noticeFooter: { fontFamily: fontFamilies.regular, fontSize: 12, lineHeight: 17, marginTop: 10, paddingTop: 10, borderTopWidth: 1 },

  // Offer card
  offerCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1, borderRadius: 16 },
  offerBody: { flex: 1, minWidth: 0 },
  offerName: { fontFamily: fontFamilies.bold, fontSize: 14, letterSpacing: -0.1 },
  offerMeta: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6, flexWrap: 'wrap' },
  storeChip: { paddingVertical: 3, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1, maxWidth: 120 },
  storeChipText: { fontSize: 11.5, fontFamily: fontFamilies.bold, letterSpacing: -0.1 },
  offerValidity: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  offerValidityText: { fontSize: 11.5, fontFamily: fontFamilies.semibold },
  offerPrices: { alignItems: 'flex-end', gap: 2, flexShrink: 0 },
  offerPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  offerOldPrice: { fontSize: 12, fontFamily: fontFamilies.semibold, textDecorationLine: 'line-through' },
  offerPrice: { fontFamily: fontFamilies.displayBold, fontSize: 17, letterSpacing: -0.3 },
  offerDiscount: { fontSize: 11, fontFamily: fontFamilies.bold },
  offerAddBtn: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },

  // Ingredient rows
  ingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  ingDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  ingInfo: { flex: 1, minWidth: 0 },
  ingName: { fontFamily: fontFamilies.semibold, fontSize: 14.5, letterSpacing: -0.1 },
  ingAmount: { fontFamily: fontFamilies.medium, fontSize: 12.5, marginTop: 1 },
  ingPrice: { fontFamily: fontFamilies.displayBold, fontSize: 13.5, letterSpacing: -0.2 },

  // Step rows
  stepToggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepToggleText: { fontFamily: fontFamilies.bold, fontSize: 12.5 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 13, paddingVertical: 13 },
  stepCircle: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepCheck: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.8, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNum: { fontFamily: fontFamilies.displayBold, fontSize: 13 },
  stepText: { flex: 1, fontFamily: fontFamilies.medium, fontSize: 14, lineHeight: 21, letterSpacing: -0.1 },

  // Nutrition
  nutritionGrid: { flexDirection: 'row', gap: 8 },
  nutritionCell: { flex: 1, borderWidth: 1, borderRadius: 13, paddingVertical: 12, paddingHorizontal: 4, alignItems: 'center' },
  nutritionValue: { fontFamily: fontFamilies.displayBold, fontSize: 18, letterSpacing: -0.4 },
  nutritionUnit: { fontFamily: fontFamilies.semibold, fontSize: 10, marginTop: 1 },
  nutritionLabel: { fontFamily: fontFamilies.semibold, fontSize: 10.5, marginTop: 4, letterSpacing: 0.1 },

  // Quiet rows
  quietRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, borderWidth: 1, borderRadius: 14 },
  quietIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  quietTitle: { fontFamily: fontFamilies.bold, fontSize: 13.5, letterSpacing: -0.1 },
  quietSub: { fontFamily: fontFamilies.medium, fontSize: 12, marginTop: 1 },
  inlineToast: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1 },

  // Comments
  commentsCard: { borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  commentsHead: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 13 },
  commentsRating: { fontFamily: fontFamilies.displayBold, fontSize: 16, letterSpacing: -0.3 },
  commentsRatingSub: { fontFamily: fontFamilies.semibold, fontSize: 12.5 },
  commentRow: { flexDirection: 'row', gap: 11, paddingVertical: 12, paddingHorizontal: 13, borderTopWidth: 1 },
  commentAvatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  commentAvatarText: { fontFamily: fontFamilies.bold, fontSize: 12 },
  commentTop: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  commentName: { fontFamily: fontFamilies.bold, fontSize: 13, flexShrink: 1 },
  commentStars: { flexDirection: 'row', gap: 1 },
  commentText: { fontFamily: fontFamilies.medium, fontSize: 13, lineHeight: 19, marginTop: 3 },
  commentsEmpty: { fontFamily: fontFamilies.medium, fontSize: 13, textAlign: 'center', paddingVertical: 16, borderTopWidth: 1 },
  commentsCta: { paddingVertical: 12, alignItems: 'center', borderTopWidth: 1 },
  commentsCtaText: { fontFamily: fontFamilies.bold, fontSize: 13 },

  // Sticky bottom bar
  stickyBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  stickyCost: { minWidth: 0, flexShrink: 1 },
  stickyCostLabel: { fontFamily: fontFamilies.semibold, fontSize: 11, letterSpacing: 0.2, textTransform: 'uppercase' },
  stickyCostValue: { fontFamily: fontFamilies.displayBold, fontSize: 19, letterSpacing: -0.4 },
  stickyCta: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  stickyCtaText: { color: '#FFF', fontFamily: fontFamilies.bold, fontSize: 16, letterSpacing: -0.1 },

  // Deck toast
  planToast: {
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
  planToastText: { color: '#FFFFFF', fontSize: 15, fontFamily: fontFamilies.bold },
});
