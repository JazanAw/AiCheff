import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useNavigation, NavigationProp } from '@react-navigation/native';
import { fontFamilies } from '../../theme';
import { usePreferences } from '../../store/PreferencesContext';
import { useSubscription } from '../../store/SubscriptionContext';
import { Deal, DealCategory } from '../../types';
import {
  fetchDealsFromBackend,
  getBackendBaseUrlForDebug,
} from '../../services/offersApi';
import { addShoppingItem, fetchShoppingList } from '../../services/shoppingListApi';
import {
  addFavoriteDeal,
  fetchFavoriteDeals,
  removeFavoriteArticle,
  removeFavoriteDeal,
} from '../../services/dealFavoritesApi';
import { fetchTrendingTerms, isTrendingDealName } from '../../services/dealTrendsApi';
import { fetchPantryItems } from '../../services/pantryApi';
import { fetchPlannerEntries } from '../../services/plannerApi';
import { splitMissingIngredients } from '../../utils/pantryMatch';
import {
  buildMixedOfferFeed,
  rankOffers,
  type OfferRankContext,
  type OfferReasonTag,
} from '../../utils/offerRanking';
import { formatEuro, useDealsTheme } from '../../components/deals/dealsTheme';
import { DealsHeaderBar, DealsSearchBar } from '../../components/deals/DealsHeader';
import { CategoryStrip, DealFilter } from '../../components/deals/CategoryStrip';
import { StoreStrip } from '../../components/deals/StoreStrip';
import { buildStoreFilters, dealMatchesStore } from '../../utils/storeBrand';
import { DealCard, DealCardVariant } from '../../components/deals/DealCard';
import { TopHeroCard } from '../../components/deals/TopHeroCard';
import { DealDetailsSheet } from '../../components/deals/DealDetailsSheet';
import { Icon } from '../../components/common/Icon';
import { floatingTabBarClearance } from '../../navigation/components/FloatingGlassTabBar';

type Nav = NavigationProp<Record<string, object | undefined>>;

// Muss die Kategorie-Chips in CategoryStrip vollstaendig abdecken — diese Liste
// speist deren Zaehler-Badges. Fehlt eine Kategorie, bleibt ihr Chip ohne Zahl.
const PRODUCT_CATEGORIES: DealCategory[] = [
  'fruits_vegetables',
  'meat_fish',
  'dairy',
  'bakery',
  'drinks',
  'snacks_sweets',
  'pantry',
  'ready_meals',
  'frozen',
  'other',
];

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function DealsScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const { colors } = useDealsTheme();
  const { preferences } = usePreferences();
  const { tier, hasFeature } = useSubscription();
  const insets = useSafeAreaInsets();

  const [deals, setDeals] = useState<Deal[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<DealFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  // Store/supermarket filter. null = "Alle Läden" (default). Combines with
  // search + category and is applied AFTER preferences + search (see below).
  const [activeStore, setActiveStore] = useState<string | null>(null);

  // UI echoes — source of truth for "added" stays Supabase via addShoppingItem.
  const [addedDealIds, setAddedDealIds] = useState<Set<string>>(new Set());
  const [addingDealId, setAddingDealId] = useState<string | null>(null);
  // Persisted in public.deal_favorites (see dealFavoritesApi). Loaded once on
  // mount; toggles are optimistic with rollback on failure.
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  // Artikel-Anker der Favoriten. `favoriteIds` bezeichnet EIN Angebot; Lidl und
  // ALDI NORD vergeben pro Aktionswoche eine neue id, wodurch der Favorit ohne
  // diesen Set nach dem Wochenwechsel unerkannt bliebe.
  const [favoriteArticleIds, setFavoriteArticleIds] = useState<Set<string>>(new Set());
  // Aggregated, anonymous trending terms from product_trend_30d. Best-effort.
  const [trendTerms, setTrendTerms] = useState<Set<string>>(new Set());
  // Personalisation context for hybrid offer ranking. All best-effort: any
  // failure leaves the relevant signal empty (conservative, never blocks).
  const [neededNames, setNeededNames] = useState<string[]>([]);
  const [shoppingNames, setShoppingNames] = useState<string[]>([]);

  const [detailDeal, setDetailDeal] = useState<Deal | null>(null);

  const hasLocation =
    typeof preferences.latitude === 'number' &&
    Number.isFinite(preferences.latitude) &&
    typeof preferences.longitude === 'number' &&
    Number.isFinite(preferences.longitude);

  const locationFilter = useMemo(() => {
    if (hasLocation) {
      return {
        mode: 'gps' as const,
        postalCode: '',
        latitude: preferences.latitude ?? null,
        longitude: preferences.longitude ?? null,
        radiusKm: preferences.searchRadiusKm,
      };
    }
    return {
      mode: 'none' as const,
      postalCode: '',
      latitude: null,
      longitude: null,
      radiusKm: preferences.searchRadiusKm,
    };
  }, [hasLocation, preferences.latitude, preferences.longitude, preferences.searchRadiusKm]);

  const fetchDeals = useCallback(async () => {
    setErrorMessage(null);
    try {
      const response = await fetchDealsFromBackend(locationFilter);
      setDeals(response.deals);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('common.error');
      setErrorMessage(`${message}\n${getBackendBaseUrlForDebug()}`);
      // Only blank the feed on a genuine initial load (no data yet). Never
      // destroy already-loaded deals because of a later failure.
      setDeals((prev) => (prev.length === 0 ? [] : prev));
    } finally {
      setLoading(false);
    }
  }, [locationFilter, t]);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  // Favorites + trends load independently and must never block the deal list.
  useEffect(() => {
    let cancelled = false;
    fetchFavoriteDeals()
      .then(({ dealIds, articleIds }) => {
        if (cancelled) return;
        setFavoriteIds(dealIds);
        setFavoriteArticleIds(articleIds);
      })
      .catch(() => {
        /* not signed in / offline — heart just starts empty */
      });
    fetchTrendingTerms()
      .then((terms) => {
        if (!cancelled) setTrendTerms(terms);
      })
      .catch(() => {
        /* trends view unavailable — Trend section simply stays discount-derived */
      });

    // Hybrid-ranking context: ingredients still needed by this week's plan
    // (pantry-aware) + names on the open shopping list. Best-effort & parallel.
    (async () => {
      try {
        const [pantry, planEntries] = await Promise.all([
          fetchPantryItems().catch(() => []),
          fetchPlannerEntries().catch(() => []),
        ]);
        if (cancelled) return;
        const needed = new Set<string>();
        for (const entry of planEntries) {
          const { missing } = splitMissingIngredients(entry.recipe.ingredients, pantry);
          for (const ing of missing) if (ing.name) needed.add(ing.name);
        }
        setNeededNames([...needed]);
      } catch {
        /* keep empty — ranking just loses the recipe-fit signal */
      }
      try {
        const list = await fetchShoppingList();
        if (!cancelled) {
          setShoppingNames(list.filter((i) => !i.checked).map((i) => i.name));
        }
      } catch {
        /* keep empty */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Pull-to-Refresh laedt NUR den vorhandenen Snapshot neu (GET /api/offers).
  //
  // Frueher rief das hier refreshDealsFromBackend() -> POST /api/offers/refresh
  // mit `tryOllama: true`. Jede Zieh-Geste startete damit einen kompletten
  // Haendler-Scrape samt LLM-Anreicherung — global, nicht pro Nutzer, ohne
  // Auth und ohne Rate-Limit. Mehrere Nutzer (oder ein genervter Nutzer, der
  // mehrfach zieht) konnten so beliebig teure Verarbeitung ausloesen und sich
  // gegenseitig den Snapshot unter den Fuessen wegziehen.
  //
  // Ingest gehoert nicht an eine UI-Geste. Er laeuft ueber den
  // Weekly-Scheduler (startWeeklyScanScheduler in backend/src/server.ts) und
  // manuell ueber /admin-v2.
  const onRefresh = async () => {
    setRefreshing(true);
    await fetchDeals();
    setRefreshing(false);
  };

  // Filter pipeline (order matters):
  //   1. base data (deals)
  //   2. preferences (halal / alcohol)  ┐ searchedDeals
  //   3. search                         ┘
  //   4. store filter                   → visibleDeals
  //   5. category / smart filter        → filteredList / curated sections
  //
  // Step 2+3: preference gating + local search. This is the base the store
  // filter options + their counts are computed from (counts reflect search but
  // NOT the active store, so switching stores keeps stable counts).
  const searchedDeals = useMemo(
    () =>
      deals.filter((deal) => {
        if (preferences.halalFilter && deal.isHalal !== true) return false;
        if (
          preferences.hideAlcohol &&
          deal.category === 'drinks' &&
          /bier|wein|vodka|gin|rum|whisky|alkohol/i.test(deal.name)
        ) {
          return false;
        }
        const query = normalizeSearchText(searchQuery);
        if (!query) return true;
        const searchable = normalizeSearchText(
          [
            deal.name,
            deal.storeName,
            deal.storeCity,
            deal.storeAddress,
            t(`deals.categories.${deal.category}`),
            deal.ingredients?.join(' '),
            deal.allergens?.join(' '),
            deal.isHalal ? 'halal' : '',
            deal.containsAlcohol === true ? 'alkohol alcohol' : '',
          ]
            .filter(Boolean)
            .join(' '),
        );
        return searchable.includes(query);
      }),
    [deals, preferences.halalFilter, preferences.hideAlcohol, searchQuery, t],
  );

  // Store filter options + counts: computed from the search base (step 3) so
  // each chip shows how many deals that store has under the current search,
  // independent of which store is currently selected. Only brands with deals
  // appear (buildStoreFilters skips empty store names → no crash, no noise).
  const storeOptions = useMemo(() => buildStoreFilters(searchedDeals), [searchedDeals]);

  // Step 4: apply the active store filter. null = "Alle Läden". Everything
  // downstream (curation, category counts, filtered list) builds on this, so
  // the store filter composes cleanly with category/Top/Für dich/Trend.
  const visibleDeals = useMemo(
    () =>
      activeStore == null
        ? searchedDeals
        : searchedDeals.filter((deal) => dealMatchesStore(deal.storeName, activeStore)),
    [searchedDeals, activeStore],
  );

  // If the selected store no longer exists in the current base (e.g. search
  // narrowed it away), fall back to "Alle Läden" so the user is never stuck on
  // an empty, unselectable filter.
  useEffect(() => {
    if (activeStore != null && !storeOptions.some((o) => o.key === activeStore)) {
      setActiveStore(null);
    }
  }, [activeStore, storeOptions]);

  // ── Curation: split the flat feed into Top / For you / Trend ─────────

  // Hybrid-ranking context (memoised). Distance/store signals come from the
  // deal itself; the rest from the loaded personalisation state. Missing data
  // → the corresponding signal is simply absent (conservative).
  const offerRankContext = useMemo<OfferRankContext>(
    () => ({
      favoriteIds,
      favoriteArticleIds,
      trendTerms,
      neededIngredientNames: neededNames,
      shoppingListNames: shoppingNames,
      searchRadiusKm: preferences.searchRadiusKm,
    }),
    [
      favoriteIds,
      favoriteArticleIds,
      trendTerms,
      neededNames,
      shoppingNames,
      preferences.searchRadiusKm,
    ],
  );

  // Value-based "Top" set powering the dedicated Top FILTER chip + its count:
  // strong discounts / backend-flagged tops, sorted by savings. Uncapped.
  const allTopDeals = useMemo(
    () =>
      [...visibleDeals]
        .filter((d) => d.highlight === 'top' || (d.savingsPercent ?? 0) >= 30)
        .sort((a, b) => (b.savingsPercent ?? 0) - (a.savingsPercent ?? 0)),
    [visibleDeals],
  );

  // Home "Top-Angebote" carousel = DIVERSE hybrid mix (one best deal per intent
  // bucket: personal/recipe/value/trending/new/expiring), de-duplicated and
  // filled up to 8 by score — not just the highest discount. This is what the
  // user perceives as "Top"; the Top filter above stays the value power-list.
  const topDeals = useMemo(
    () => buildMixedOfferFeed(visibleDeals, offerRankContext, 8).map((s) => s.offer),
    [visibleDeals, offerRankContext],
  );

  // A deal trends when the backend flagged it OR its name matches an anonymous,
  // aggregated trending term from product_trend_30d (see dealTrendsApi).
  const isTrend = useCallback(
    (deal: Deal) => deal.highlight === 'trend' || isTrendingDealName(deal.name, trendTerms),
    [trendTerms],
  );

  // Trend section excludes whatever is already in the Top carousel (no dupes).
  const allTrendDeals = useMemo(() => {
    const topIds = new Set(topDeals.map((d) => d.id));
    return visibleDeals.filter((d) => !topIds.has(d.id) && isTrend(d));
  }, [visibleDeals, topDeals, isTrend]);
  const trendDeals = useMemo(() => allTrendDeals.slice(0, 8), [allTrendDeals]);

  // "Für dich" = everything not already in the Top carousel or Trend section,
  // hybrid-ranked (relevance/pantry/trend/value/…). UNCAPPED so every backend
  // offer is reachable. `Deal` is a structural superset of `RankableOffer`.
  const forYouRanked = useMemo(() => {
    const used = new Set([...topDeals, ...trendDeals].map((d) => d.id));
    const rest = visibleDeals.filter((d) => !used.has(d.id));
    return rankOffers(rest, offerRankContext);
  }, [visibleDeals, topDeals, trendDeals, offerRankContext]);
  const forYouDeals = useMemo(() => forYouRanked.map((scored) => scored.offer), [forYouRanked]);
  // dealId → reason tags (only "Für dich" deals carry hybrid reasons).
  const forYouReasons = useMemo(() => {
    const map = new Map<string, OfferReasonTag[]>();
    for (const scored of forYouRanked) map.set(scored.offer.id, scored.reasons);
    return map;
  }, [forYouRanked]);

  const counts = useMemo(() => {
    const c: Partial<Record<DealFilter, number>> = {
      top: allTopDeals.length,
      trend: allTrendDeals.length,
    };
    PRODUCT_CATEGORIES.forEach((cat) => {
      c[cat] = visibleDeals.filter((d) => d.category === cat).length;
    });
    return c;
  }, [visibleDeals, allTopDeals.length, allTrendDeals.length]);

  const handleAddToList = useCallback(
    async (deal: Deal) => {
      if (addedDealIds.has(deal.id) || addingDealId === deal.id) return;
      setAddingDealId(deal.id);
      try {
        await addShoppingItem({
          name: deal.name,
          quantity: 1,
          storeName: deal.storeName,
          price: deal.currentPrice,
          dealId: deal.id,
          isManual: false,
        });
        setAddedDealIds((prev) => new Set(prev).add(deal.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : t('deals.addToListError');
        Alert.alert(t('deals.addToListError'), message);
      } finally {
        setAddingDealId(null);
      }
    },
    [addedDealIds, addingDealId, t],
  );

  /** Ein Angebot gilt als favorisiert, wenn ENTWEDER genau dieses Angebot
   *  favorisiert wurde ODER derselbe Artikel — Letzteres traegt den Favoriten
   *  ueber den Wochenwechsel. */
  const isFavorite = useCallback(
    (deal: Deal) =>
      favoriteIds.has(deal.id) ||
      (deal.articleId !== undefined && favoriteArticleIds.has(deal.articleId)),
    [favoriteIds, favoriteArticleIds],
  );

  const toggleFavorite = useCallback((deal: Deal) => {
    const articleId = deal.articleId;
    const byDealId = favoriteIds.has(deal.id);
    const byArticleId = articleId !== undefined && favoriteArticleIds.has(articleId);
    const wasFavorite = byDealId || byArticleId;

    // Optimistisch beide Anker mitfuehren, sonst bliebe das Herz nach dem
    // Enthertzen eines Favoriten aus einer frueheren Woche gefuellt.
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (wasFavorite) next.delete(deal.id);
      else next.add(deal.id);
      return next;
    });
    if (articleId !== undefined) {
      setFavoriteArticleIds((prev) => {
        const next = new Set(prev);
        if (wasFavorite) next.delete(articleId);
        else next.add(articleId);
        return next;
      });
    }

    // Beim Entfernen zaehlt, WORUEBER der Favorit gefunden wurde: eine Zeile aus
    // einer frueheren Woche traegt eine andere deal_id und liesse sich ueber
    // diese nie loeschen.
    const persist = !wasFavorite
      ? addFavoriteDeal(deal)
      : byDealId
        ? removeFavoriteDeal(deal.id)
        : removeFavoriteArticle(articleId as string);

    persist.catch(() => {
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (byDealId) next.add(deal.id);
        else next.delete(deal.id);
        return next;
      });
      if (articleId !== undefined) {
        setFavoriteArticleIds((prev) => {
          const next = new Set(prev);
          if (byArticleId) next.add(articleId);
          else next.delete(articleId);
          return next;
        });
      }
    });
  }, [favoriteIds, favoriteArticleIds]);

  const goToPreferences = () => navigation.navigate('Profile', { screen: 'Preferences' });
  const goToSubscription = () => navigation.navigate('Profile', { screen: 'Subscription' });

  const variantFor = (deal: Deal): DealCardVariant =>
    deal.highlight === 'top' ? 'top' : isTrend(deal) ? 'trend' : 'normal';

  const badgeFor = (deal: Deal): string | undefined =>
    deal.savingsAbsolute != null && deal.highlight === 'top'
      ? t('deals.saves', { amount: formatEuro(deal.savingsAbsolute) })
      : undefined;

  const renderCard = (deal: Deal, variant?: DealCardVariant) => (
    <DealCard
      key={deal.id}
      deal={deal}
      variant={variant ?? variantFor(deal)}
      canSeeNutrition={hasFeature('nutrition')}
      favorite={isFavorite(deal)}
      isAdded={addedDealIds.has(deal.id)}
      isAdding={addingDealId === deal.id}
      badge={badgeFor(deal)}
      reasonTags={forYouReasons.get(deal.id)}
      onPress={() => setDetailDeal(deal)}
      onAddToList={() => handleAddToList(deal)}
      onToggleFavorite={() => toggleFavorite(deal)}
    />
  );

  const locationLabel = hasLocation
    ? `${t('deals.local')} · ${preferences.searchRadiusKm} km`
    : null;

  // Deals for a single non-curated filter selection — all uncapped, so a chip
  // always shows every matching deal (chip count == list length).
  const filteredList = useMemo(() => {
    if (filter === 'top') return allTopDeals;
    if (filter === 'trend') return allTrendDeals;
    if (filter === 'forYou') return forYouDeals;
    if (filter === 'all') return [];
    return visibleDeals.filter((d) => d.category === filter);
  }, [filter, allTopDeals, allTrendDeals, forYouDeals, visibleDeals]);

  const showCurated = filter === 'all';
  const isSearching = searchQuery.trim().length > 0;
  // Error-state separation (Problem 4):
  //   - no data at all + error  → full error state with retry (initial load)
  //   - data present  + error   → keep the feed, show a small inline banner
  const initialLoading = loading && deals.length === 0;
  const initialError = !!errorMessage && deals.length === 0;
  const refreshError = !!errorMessage && deals.length > 0;
  const listData = initialLoading || initialError ? [] : showCurated ? forYouDeals : filteredList;

  // Search + categories + (optional) inline refresh banner + curated section
  // heads. Lives in the FlatList header so it SCROLLS away with the feed; only
  // the title bar above stays pinned. Present in every state.
  const feedHeader = (
    <View>
      <DealsSearchBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onPressFilters={goToPreferences}
      />
      <CategoryStrip active={filter} onChange={setFilter} counts={counts} />
      <StoreStrip options={storeOptions} active={activeStore} onChange={setActiveStore} />

      {refreshError && (
        <Pressable onPress={onRefresh} style={[styles.banner, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
          <Icon name="info" size={14} color={colors.textSecondary} />
          <Text style={[styles.bannerText, { color: colors.textSecondary }]} numberOfLines={2}>
            {t('deals.fallback.refreshError')}
          </Text>
          <Text style={[styles.bannerAction, { color: colors.primary }]}>{t('deals.fallback.retry')}</Text>
        </Pressable>
      )}

      {!initialLoading && !initialError && showCurated && (
        <>
          {topDeals.length > 0 && (
            <>
              <SectionHead
                title={t('deals.sections.topTitle')}
                subtitle={t('deals.sections.topSubtitle')}
                action={t('deals.seeAll')}
                onAction={() => setFilter('top')}
              />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.carousel}
              >
                {topDeals.map((deal) => (
                  <TopHeroCard
                    key={deal.id}
                    deal={deal}
                    favorite={isFavorite(deal)}
                    onPress={() => setDetailDeal(deal)}
                    onToggleFavorite={() => toggleFavorite(deal)}
                  />
                ))}
              </ScrollView>
            </>
          )}
          {forYouDeals.length > 0 && (
            <SectionHead
              title={t('deals.sections.forYouTitle')}
              subtitle={t('deals.sections.forYouSubtitle')}
            />
          )}
        </>
      )}
    </View>
  );

  const renderEmpty = () => {
    if (initialLoading) return <SkeletonList />;
    if (initialError) {
      return (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {t('deals.fallback.loadError')}
          </Text>
          <Pressable onPress={onRefresh} style={[styles.retryBtn, { borderColor: colors.border }]}>
            <Text style={[styles.retryText, { color: colors.primary }]}>{t('deals.fallback.retry')}</Text>
          </Pressable>
        </View>
      );
    }
    // Data is empty but the feed loaded. If the curated view still shows a Top
    // carousel / Trend section, render nothing here.
    if (showCurated && (topDeals.length > 0 || trendDeals.length > 0)) return null;
    // Store filter takes precedence in the message: a selected store with no
    // (remaining) matches is the most specific reason the list is empty.
    const emptyText = activeStore != null
      ? t('deals.noStoreResults')
      : isSearching
        ? t('deals.noResults')
        : t('deals.noDeals');
    return (
      <View style={styles.empty}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{emptyText}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      {/* Pinned: only the title + HeaderActions stay fixed. */}
      <DealsHeaderBar locationLabel={locationLabel} onPressLocation={goToPreferences} />

      <FlatList
        data={listData}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <View style={styles.cardItem}>{renderCard(item)}</View>}
        contentContainerStyle={[styles.scroll, { paddingBottom: floatingTabBarClearance(insets.bottom) }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={8}
        windowSize={11}
        removeClippedSubviews
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListHeaderComponent={feedHeader}
        ListFooterComponent={
          !initialLoading && !initialError && showCurated && trendDeals.length > 0 ? (
            <View>
              <SectionHead
                title={t('deals.sections.trendTitle')}
                subtitle={t('deals.sections.trendSubtitle')}
              />
              {trendDeals.map((deal) => (
                <View key={deal.id} style={styles.cardItem}>
                  {renderCard(deal, 'trend')}
                </View>
              ))}
            </View>
          ) : null
        }
        ListEmptyComponent={renderEmpty()}
      />

      <DealDetailsSheet
        deal={detailDeal}
        visible={detailDeal != null}
        tier={tier}
        favorite={detailDeal ? favoriteIds.has(detailDeal.id) : false}
        isAdded={detailDeal ? addedDealIds.has(detailDeal.id) : false}
        isAdding={detailDeal ? addingDealId === detailDeal.id : false}
        onClose={() => setDetailDeal(null)}
        onAddToList={() => detailDeal && handleAddToList(detailDeal)}
        onToggleFavorite={() => detailDeal && toggleFavorite(detailDeal)}
        onUpgrade={goToSubscription}
      />
    </SafeAreaView>
  );
}

function SectionHead({
  title,
  subtitle,
  action,
  onAction,
}: {
  title: string;
  subtitle?: string;
  action?: string;
  onAction?: () => void;
}) {
  const { colors } = useDealsTheme();
  return (
    <View style={styles.sectionHead}>
      <View style={{ flexShrink: 1 }}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
        {subtitle && <Text style={[styles.sectionSub, { color: colors.textTertiary }]}>{subtitle}</Text>}
      </View>
      {action && (
        <Pressable onPress={onAction} hitSlop={6}>
          <Text style={[styles.sectionAction, { color: colors.primary }]}>{action} ›</Text>
        </Pressable>
      )}
    </View>
  );
}

function SkeletonList() {
  const { colors } = useDealsTheme();
  return (
    <View style={[styles.cardList, styles.cardListTop]}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.skeleton, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
          <View style={[styles.skeletonThumb, { backgroundColor: colors.skeleton }]} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={[styles.skeletonLine, { backgroundColor: colors.skeleton, width: '40%' }]} />
            <View style={[styles.skeletonLine, { backgroundColor: colors.skeleton, width: '80%' }]} />
            <View style={[styles.skeletonLine, { backgroundColor: colors.skeleton, width: '30%', height: 18 }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingBottom: 110 },
  carousel: { paddingLeft: 20, paddingRight: 8, gap: 12, paddingBottom: 4 },
  cardList: { paddingHorizontal: 20, gap: 10 },
  cardListTop: { paddingTop: 6 },
  cardItem: { paddingHorizontal: 20, paddingBottom: 10 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 20,
    marginTop: 4,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  bannerText: { flex: 1, fontSize: 12.5, fontFamily: fontFamilies.medium },
  bannerAction: { fontSize: 12.5, fontFamily: fontFamilies.bold },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginTop: 22,
    marginBottom: 10,
  },
  sectionTitle: { fontFamily: fontFamilies.displaySemibold, fontSize: 22, letterSpacing: -0.4, lineHeight: 24 },
  sectionSub: { fontSize: 12, fontFamily: fontFamilies.medium, marginTop: 3 },
  sectionAction: { fontSize: 13, fontFamily: fontFamilies.bold },
  empty: { paddingTop: 64, alignItems: 'center', gap: 12, paddingHorizontal: 20 },
  emptyText: { fontSize: 15, fontFamily: fontFamilies.regular, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  retryText: { fontSize: 14, fontFamily: fontFamilies.semibold },
  skeleton: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1 },
  skeletonThumb: { width: 88, height: 88, borderRadius: 10 },
  skeletonLine: { height: 12, borderRadius: 6 },
});
