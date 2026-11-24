import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import type { ThemeColors } from '../../theme';
import { formatEuro } from '../../components/deals/dealsTheme';
import {
  fetchFavoriteRows,
  removeFavoriteArticle,
  removeFavoriteDeal,
  type FavoriteRow,
} from '../../services/dealFavoritesApi';
import { fetchArticleOffers, type ArticleOffersResult } from '../../services/offersApi';

interface Props {
  onBack: () => void;
}

/** Ein Favorit plus sein aktueller Angebotsstatus. `live === undefined` heißt
 *  „noch nicht aufgelöst" (kein Artikel-Anker oder Abruf fehlgeschlagen) — das
 *  ist etwas anderes als „nicht im Angebot" und wird auch anders angezeigt. */
interface FavoriteEntry {
  row: FavoriteRow;
  live?: ArticleOffersResult;
  failed?: boolean;
}

/** Wie viele Artikel gleichzeitig aufgelöst werden. Jeder Favorit ist ein
 *  eigener Request; ohne Deckel würde eine lange Liste das Backend fluten. */
const RESOLVE_CONCURRENCY = 5;

async function resolveInBatches(rows: FavoriteRow[]): Promise<FavoriteEntry[]> {
  const entries: FavoriteEntry[] = rows.map((row) => ({ row }));
  const resolvable = entries.filter((entry) => entry.row.articleId !== null);

  for (let index = 0; index < resolvable.length; index += RESOLVE_CONCURRENCY) {
    const slice = resolvable.slice(index, index + RESOLVE_CONCURRENCY);
    await Promise.all(
      slice.map(async (entry) => {
        try {
          entry.live = await fetchArticleOffers(entry.row.articleId as string);
        } catch {
          // Einzelner Ausfall darf die Liste nicht kippen — der Favorit wird
          // mit seinem gespeicherten Snapshot gezeigt und ehrlich markiert.
          entry.failed = true;
        }
      }),
    );
  }
  return entries;
}

function formatUntil(iso: string, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
}

export function FavoritesScreen({ onBack }: Props) {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();

  const [entries, setEntries] = useState<FavoriteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const rows = await fetchFavoriteRows();
    // Im Angebot zuerst, danach alphabetisch — die Liste beantwortet damit die
    // eigentliche Frage („was ist gerade günstig?") ohne Scrollen.
    const resolved = await resolveInBatches(rows);
    resolved.sort((a, b) => {
      const aOn = a.live?.isOnOffer === true ? 0 : 1;
      const bOn = b.live?.isOnOffer === true ? 0 : 1;
      return aOn !== bOn ? aOn - bOn : a.row.dealName.localeCompare(b.row.dealName);
    });
    setEntries(resolved);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load()
      .catch((e) => setError((e as Error).message))
      .finally(() => setRefreshing(false));
  }, [load]);

  const remove = useCallback((entry: FavoriteEntry) => {
    const { row } = entry;
    setEntries((prev) => prev.filter((item) => item.row.dealId !== row.dealId));
    // Über denselben Anker löschen, unter dem die Zeile gespeichert wurde.
    const persist = row.articleId
      ? removeFavoriteArticle(row.articleId)
      : removeFavoriteDeal(row.dealId);
    persist.catch(() => {
      setEntries((prev) => [...prev, entry]);
    });
  }, []);

  const onOfferCount = entries.filter((entry) => entry.live?.isOnOffer === true).length;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.background }]}
      edges={['top']}
    >
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={[typography.button, { color: colors.primary }]}>{t('common.back')}</Text>
        </Pressable>
        <Text style={[typography.h3, { color: colors.text }]}>{t('favorites.title')}</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {loading ? (
          <ActivityIndicator style={{ marginTop: spacing.xxl }} color={colors.primary} />
        ) : error ? (
          <View style={[styles.empty, { borderColor: colors.border }]}>
            <Text style={[typography.body, { color: colors.textSecondary }]}>{error}</Text>
          </View>
        ) : entries.length === 0 ? (
          <View style={[styles.empty, { borderColor: colors.border }]}>
            <Text style={[typography.body, { color: colors.text }]}>
              {t('favorites.emptyTitle')}
            </Text>
            <Text
              style={[
                typography.caption,
                { color: colors.textSecondary, marginTop: spacing.xs, textAlign: 'center' },
              ]}
            >
              {t('favorites.emptyHint')}
            </Text>
          </View>
        ) : (
          <>
            <Text style={[typography.caption, { color: colors.textSecondary }]}>
              {t('favorites.summary', { onOffer: onOfferCount, total: entries.length })}
            </Text>
            {entries.map((entry) => (
              <FavoriteCard
                key={entry.row.dealId}
                entry={entry}
                colors={colors}
                locale={i18n.language}
                t={t}
                onRemove={() => remove(entry)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function FavoriteCard({
  entry,
  colors,
  locale,
  t,
  onRemove,
}: {
  entry: FavoriteEntry;
  colors: ThemeColors;
  locale: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  onRemove: () => void;
}) {
  const { row, live, failed } = entry;
  const best = live?.locations[0];

  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {row.imageUrl ? (
        <Image source={{ uri: row.imageUrl }} style={styles.image} />
      ) : (
        <View style={[styles.image, { backgroundColor: colors.border }]} />
      )}

      <View style={styles.cardBody}>
        <Text style={[typography.body, { color: colors.text }]} numberOfLines={2}>
          {row.dealName}
        </Text>

        {live?.isOnOffer && best ? (
          <>
            <View style={styles.statusRow}>
              <View style={[styles.pill, { backgroundColor: colors.primary }]}>
                <Text style={styles.pillText}>{t('favorites.onOffer')}</Text>
              </View>
              <Text style={[typography.h3, { color: colors.primary }]}>
                {formatEuro(best.price)}
              </Text>
            </View>
            <Text style={[typography.caption, { color: colors.textSecondary }]}>
              {best.storeChain}
              {best.storeCity ? ` · ${best.storeCity}` : ''}
              {formatUntil(best.validityEnd, locale)
                ? ` · ${t('favorites.until', { date: formatUntil(best.validityEnd, locale) })}`
                : ''}
            </Text>
            {live.locations.length > 1 && (
              <Text style={[typography.caption, { color: colors.textSecondary }]}>
                {t('favorites.moreStores', { count: live.locations.length - 1 })}
              </Text>
            )}
          </>
        ) : (
          <>
            <Text style={[typography.caption, { color: colors.textSecondary }]}>
              {failed || row.articleId === null
                ? t('favorites.statusUnknown')
                : live && live.nextWeekCount > 0
                  ? t('favorites.nextWeek')
                  : t('favorites.notOnOffer')}
            </Text>
            {row.currentPrice !== null && (
              <Text style={[typography.caption, { color: colors.textSecondary }]}>
                {t('favorites.lastSeen', {
                  price: formatEuro(row.currentPrice),
                  store: row.storeName ?? '—',
                })}
              </Text>
            )}
          </>
        )}
      </View>

      <Pressable onPress={onRemove} hitSlop={8} style={styles.remove}>
        <Text style={[typography.button, { color: colors.textSecondary }]}>
          {t('favorites.remove')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  empty: {
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.md,
  },
  image: { width: 56, height: 56, borderRadius: radius.sm, resizeMode: 'cover' },
  cardBody: { flex: 1, gap: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pill: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  remove: { paddingLeft: spacing.sm },
});
