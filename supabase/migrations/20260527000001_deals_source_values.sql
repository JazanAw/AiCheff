-- Cheffity: cleanup of `deals.source` provenance.
--
-- The original CHECK constraint (`20260507000005_deals.sql`) only allowed
-- `('marktguru', 'kaufda', 'manual')`. The Marktguru live source has been
-- replaced by `OfficialSupermarketSourceConnector` (direct supermarket
-- scrapes), `LocalMarketConnector` (OCR Prospekte) and the manual REWE
-- browser/screenshot/PDF import. The sync layer (`supabaseDealsSync.ts`)
-- previously hardcoded `source = 'marktguru'` for everything, which would
-- (a) be untrue and (b) defeat the unique-(source,source_external_id)
-- dedup key once we start writing the real source.
--
-- This migration:
--   1. Renames any leftover `source='marktguru'` rows whose external IDs
--      come from the new live scrape (`source_external_id LIKE 'official_%'`)
--      to `source='official'`. This is a SAFE in-place rename — same row,
--      same external_id, just a corrected provenance tag. No data deleted.
--   2. Same idea for OCR (`local_%` → `local_ocr`) and the manual REWE
--      bookmarklet import (`rewe_browser_%` → `manual_rewe_import`).
--   3. Replaces the CHECK constraint with the new value list. Legacy
--      `marktguru` / `kaufda` stay allowed so any *not yet classified* old
--      row keeps validating until it is overwritten by a fresh sync run.
--
-- DEDUP NOTE: We rename rather than insert-new because the unique
-- constraint is `(source, source_external_id)`. If we left the old row at
-- `marktguru` and let the next sync write the same external_id under
-- `official`, we would end up with two rows for the same physical offer.

-- 1) Rename rows in-place based on the stable ID prefix produced by each
--    connector. UPDATE is fine even with the existing CHECK constraint —
--    the new values 'official', 'local_ocr', 'manual_rewe_import' will be
--    rejected until step 3, so we do the constraint swap FIRST.

alter table public.deals
  drop constraint if exists deals_source_check;

alter table public.deals
  add  constraint deals_source_check
    check (source in (
      'official',
      'local_ocr',
      'manual_rewe_import',
      'manual',
      'marktguru',
      'kaufda'
    ));

-- 2) Reclassify legacy rows whose external IDs reveal the real source.
update public.deals
   set source = 'official'
 where source = 'marktguru'
   and source_external_id like 'official\_%' escape '\';

update public.deals
   set source = 'local_ocr'
 where source = 'marktguru'
   and source_external_id like 'local\_%' escape '\';

update public.deals
   set source = 'manual_rewe_import'
 where source = 'marktguru'
   and source_external_id like 'rewe\_browser\_%' escape '\';

-- Anything left at source='marktguru' has no recognizable prefix — leave
-- it untouched (no data loss) until a fresh sync overwrites it. The next
-- sync will write the new canonical source, and the natural valid_to
-- expiry will eventually retire the orphans.
