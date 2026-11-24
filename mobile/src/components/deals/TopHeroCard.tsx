import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fontFamilies } from '../../theme';
import { Deal } from '../../types';
import { DiscountBadge, FavoriteButton, StoreTag } from './DealBits';
import { ProductThumb, thumbSeed, thumbTint } from './ProductThumb';
import { formatEuro, useDealsTheme } from './dealsTheme';

interface Props {
  deal: Deal;
  favorite?: boolean;
  onPress?: () => void;
  onToggleFavorite?: () => void;
}

/** 240px-wide hero tile used in the horizontal "Top Angebote" carousel. */
export function TopHeroCard({ deal, favorite, onPress, onToggleFavorite }: Props) {
  const { colors, dark } = useDealsTheme();
  const seed = thumbSeed(deal.id || deal.name);
  const tint = thumbTint(deal.id || deal.name);

  return (
    <Pressable
      onPress={onPress}
      style={[styles.card, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
    >
      <View style={[styles.hero, { backgroundColor: dark ? `${tint}22` : `${tint}cc` }]}>
        <ProductThumb imageUrl={deal.imageUrl} seed={seed} tint={tint} size={108} radius={14} />
        {deal.savingsPercent != null && deal.savingsPercent > 0 && (
          <View style={styles.heroBadge}>
            <DiscountBadge value={deal.savingsPercent} variant="top" />
          </View>
        )}
        <View style={styles.heroFav}>
          <FavoriteButton active={favorite} onPress={onToggleFavorite} />
        </View>
      </View>
      <View style={styles.body}>
        <StoreTag name={deal.storeName} />
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={2}>
          {deal.name}
        </Text>
        <View style={styles.priceRow}>
          <Text style={[styles.priceNow, { color: colors.primary }]}>
            {formatEuro(deal.currentPrice, false)}
          </Text>
          {deal.originalPrice != null && deal.originalPrice > deal.currentPrice && (
            <Text style={[styles.priceWas, { color: colors.textTertiary }]}>
              {formatEuro(deal.originalPrice, false)}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { width: 240, borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  hero: { height: 130, alignItems: 'center', justifyContent: 'center' },
  heroBadge: { position: 'absolute', top: 10, left: 10 },
  heroFav: { position: 'absolute', top: 10, right: 10 },
  body: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 },
  name: { marginTop: 6, fontSize: 14, fontFamily: fontFamilies.bold, letterSpacing: -0.1, minHeight: 36, lineHeight: 18 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 },
  priceNow: { fontFamily: fontFamilies.displayBold, fontSize: 22, letterSpacing: -0.5, lineHeight: 24 },
  priceWas: { fontSize: 12, fontFamily: fontFamilies.medium, textDecorationLine: 'line-through' },
});
