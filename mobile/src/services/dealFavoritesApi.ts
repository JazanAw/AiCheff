import { supabase } from '../config/supabase';
import type { Deal } from '../types';

// Persistent deal favorites (the heart toggle on the Angebote screen).
//
// `deal_id` is the backend offer id (Deal.id) stored as text — it is NOT the
// public.deals UUID, since mobile deals come from the Express /api/offers feed
// whose ids are external (e.g. "mg_21652062"). See the deal_favorites migration.
//
// `article_id` wird ZUSÄTZLICH gespeichert, weil `deal_id` genau EIN
// Händler-Angebot bezeichnet: Lidl und ALDI NORD legen pro Aktionswoche eine
// neue Produktseite an, wodurch die id für dieselbe Ware wechselt (gemessen
// 2026-08-17: Lidl 0 von 3 Cross-Wochen-Produkten behielten ihre id). Ohne den
// Artikel-Anker liesse sich ein Favorit nach dem Wochenwechsel nur noch als
// eingefrorener Snapshot rendern, statt wieder auf ein gültiges Angebot zu
// zeigen. Siehe Migration 20260817000002_deal_article_id.

export interface FavoriteDealKeys {
  /** Angebots-ids — treffen das exakt favorisierte Angebot dieser Woche. */
  dealIds: Set<string>;
  /** Artikel-ids — tragen den Favoriten ueber den Wochenwechsel. */
  articleIds: Set<string>;
}

/**
 * Favoriten des angemeldeten Nutzers als BEIDE Schluessel.
 *
 * Die `article_id` wurde bisher zwar geschrieben, aber nie zurueckgelesen — der
 * Favorit erkannte dasselbe Produkt eine Woche spaeter nicht wieder.
 */
export async function fetchFavoriteDeals(): Promise<FavoriteDealKeys> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Nicht angemeldet');

  const { data, error } = await supabase
    .from('deal_favorites')
    .select('deal_id, article_id')
    .eq('user_id', user.id);
  if (error) throw error;

  const dealIds = new Set<string>();
  const articleIds = new Set<string>();
  for (const row of (data ?? []) as { deal_id: string; article_id: string | null }[]) {
    dealIds.add(row.deal_id);
    if (row.article_id) articleIds.add(row.article_id);
  }
  return { dealIds, articleIds };
}

/** Eine gespeicherte Favoritenzeile inkl. des denormalisierten Snapshots, den
 *  die Liste zeigt, solange kein aktuelles Angebot gefunden wird. */
export interface FavoriteRow {
  dealId: string;
  articleId: string | null;
  dealName: string;
  storeName: string | null;
  currentPrice: number | null;
  imageUrl: string | null;
}

/** Favoriten des angemeldeten Nutzers mit allen Anzeigefeldern. */
export async function fetchFavoriteRows(): Promise<FavoriteRow[]> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Nicht angemeldet');

  const { data, error } = await supabase
    .from('deal_favorites')
    .select('deal_id, article_id, deal_name, store_name, current_price, image_url')
    .eq('user_id', user.id);
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    dealId: String(row.deal_id ?? ''),
    articleId: typeof row.article_id === 'string' ? row.article_id : null,
    dealName: String(row.deal_name ?? ''),
    storeName: typeof row.store_name === 'string' ? row.store_name : null,
    currentPrice: typeof row.current_price === 'number' ? row.current_price : null,
    imageUrl: typeof row.image_url === 'string' ? row.image_url : null,
  }));
}

/**
 * Add a favorite. Idempotent ueber `ignoreDuplicates`, NICHT ueber ein Update.
 *
 * `deal_favorites` hat bewusst weder UPDATE-Grant noch UPDATE-Policy („ein
 * Favorit ist ein Toggle", siehe Migration 20260521000001). Ein echtes Upsert
 * wuerde auf einer bereits vorhandenen Zeile in ein UPDATE umschlagen und damit
 * abgelehnt — erreichbar, sobald {@link fetchFavoriteDeals} beim Start
 * fehlschlaegt und der lokale Set leer bleibt. `ignoreDuplicates` erzeugt
 * stattdessen ON CONFLICT DO NOTHING und kommt mit dem INSERT-Grant aus.
 *
 * Folge: der denormalisierte Snapshot (Preis/Bild) einer bestehenden Zeile wird
 * nicht aufgefrischt. Das ist gewollt — die Live-Werte kommen ohnehin ueber die
 * Artikel-Aufloesung, der Snapshot ist nur Anzeige-Rueckfall.
 */
export async function addFavoriteDeal(deal: Deal): Promise<void> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Nicht angemeldet');

  const { error } = await supabase.from('deal_favorites').upsert(
    {
      user_id: user.id,
      deal_id: deal.id,
      article_id: deal.articleId ?? null,
      deal_name: deal.name,
      store_name: deal.storeName,
      current_price: Number.isFinite(deal.currentPrice) ? deal.currentPrice : null,
      image_url: deal.imageUrl ?? null,
    },
    { onConflict: 'user_id,deal_id', ignoreDuplicates: true },
  );
  if (error) throw error;
}

/** Entfernt alle Favoriten-Zeilen dieses Artikels — noetig, wenn der Nutzer ein
 *  Angebot enthertzt, das er in einer FRUEHEREN Woche unter einer anderen
 *  Angebots-id favorisiert hatte. */
export async function removeFavoriteArticle(articleId: string): Promise<void> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Nicht angemeldet');

  const { error } = await supabase
    .from('deal_favorites')
    .delete()
    .eq('user_id', user.id)
    .eq('article_id', articleId);
  if (error) throw error;
}

/** Remove a favorite. */
export async function removeFavoriteDeal(dealId: string): Promise<void> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Nicht angemeldet');

  const { error } = await supabase
    .from('deal_favorites')
    .delete()
    .eq('user_id', user.id)
    .eq('deal_id', dealId);
  if (error) throw error;
}
