# Stripe-Integration — Folgeplan

> Status: **Code implementiert (Dev/Web), externer Checkout standardmäßig
> deaktiviert.** Edge Functions, Migration und Mobile-Wiring sind da; der
> mobile Checkout-/Portal-Flow läuft nur, wenn
> `EXPO_PUBLIC_ENABLE_EXTERNAL_STRIPE_CHECKOUT=true` gesetzt ist. Was noch
> fehlt, sind die manuellen Stripe-Dashboard-Schritte + Secrets (Abschnitt 4/5)
> und ein Test-Mode-Durchlauf. **Keine** Store-Release-Zahlung aktiviert (kein
> IAP, kein nativer Stripe-SDK-Einbau). Siehe Abschnitt 13 (Implementierungs-Status).
> Stand: 2026-05-14.

---

## 1. Ziel & Scope

Subscriptions (`plus` 2,99 €/Monat, `premium` 5,99 €/Monat) über Stripe
verwalten. Kein Free Trial (Anti-Abuse).

Drei Flows:
1. **Checkout** — User wählt Tier → Stripe Checkout → Bezahlung.
2. **Portal** — User verwaltet/kündigt Abo → Stripe Customer Portal.
3. **Webhook** — Stripe meldet Zustandsänderungen → `public.subscriptions` wird aktualisiert.

---

## 2. Was bereits existiert (nicht neu bauen)

- **Tabelle `public.subscriptions`** (`supabase/migrations/20260507000002_users.sql`):
  `user_id`, `tier`, `status`, `stripe_customer_id`, `stripe_subscription_id`,
  `current_period_start/end`, `cancel_at_period_end`, `set_by_admin`.
- **RLS**: `authenticated` darf nur die eigene Zeile **lesen**. Schreiben nur
  Admin oder `service_role` — d.h. der Webhook läuft mit `service_role` und
  umgeht RLS. (So im Migrations-Kommentar bereits vorgesehen.)
- **Realtime**: `subscriptions` ist in der `supabase_realtime`-Publication.
- **`SubscriptionContext`** (`mobile/src/store/SubscriptionContext.tsx`) hört
  bereits live auf `postgres_changes` für die eigene `subscriptions`-Zeile.
  → Sobald der Webhook die Zeile schreibt, schaltet die App automatisch um.
  **Es ist also kein zusätzlicher Client-Polling-Code nötig.**
- **`supabase/functions/`** existiert bereits (`delete-account`) — Edge
  Functions sind die etablierte Stelle für serverseitige Logik.
- **`expo-web-browser`** ist bereits Dependency → Hosted Checkout / Portal
  können ohne neue Library im Browser geöffnet werden.

**Fazit:** DB-Schema und der Realtime-Refresh-Pfad sind fertig. Es fehlen nur
die drei Edge Functions, das Stripe-Dashboard-Setup und das Wiring im
`SubscriptionScreen`.

---

## 3. Architektur-Entscheidung

**Empfehlung: Supabase Edge Functions + Stripe Hosted Checkout/Portal.**

Begründung:
- Das Express-Backend (Port 8787) ist das Offers-/Daten-Backend und in Prod
  nicht zwingend öffentlich erreichbar. Die mobile App spricht sonst nur
  Supabase. Stripe-Logik gehört dorthin, wo schon `service_role` + Secrets
  liegen → Edge Functions.
- Hosted Checkout/Portal = keine PCI-Last, keine `@stripe/stripe-react-native`
  Library nötig. Die App öffnet nur eine URL via `expo-web-browser`.
- Konsistent mit den Projektregeln ("Edge Functions für serverseitige Logik",
  "keine neuen großen Libraries ohne Begründung").

Drei neue Functions unter `supabase/functions/`:
- `stripe-checkout/` — erstellt eine Checkout-Session, gibt URL zurück.
- `stripe-portal/` — erstellt eine Portal-Session, gibt URL zurück.
- `stripe-webhook/` — empfängt Stripe-Events, schreibt `subscriptions`.

Stripe-SDK in den Functions: `npm:stripe` (Deno-kompatibel) — nur serverseitig,
keine Client-Library.

---

## 4. Stripe-Dashboard-Setup (manuell, einmalig)

1. **Produkte/Preise** anlegen (Test- **und** Live-Mode):
   - Produkt "Cheffity Plus" → recurring Price 2,99 €/Monat → `price_...` notieren.
   - Produkt "Cheffity Premium" → recurring Price 5,99 €/Monat → `price_...` notieren.
2. **Customer Portal** konfigurieren (Settings → Billing → Customer Portal):
   erlaubte Aktionen (Kündigen, Zahlungsmittel ändern, Plan wechseln),
   Branding, Rückkehr-URL.
3. **Webhook-Endpoint** anlegen → URL der `stripe-webhook` Edge Function →
   `whsec_...` (Signing Secret) notieren. Events siehe Abschnitt 8.
4. **API-Keys** aus dem Dashboard: `sk_test_...` / `sk_live_...`.

---

## 5. Benötigte Env Vars

### Supabase Edge Function Secrets (`supabase secrets set ...`)
| Var | Zweck |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` / `sk_live_...` — Stripe API-Calls |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` — Signaturprüfung im Webhook |
| `STRIPE_PRICE_PLUS` | `price_...` für Tier `plus` |
| `STRIPE_PRICE_PREMIUM` | `price_...` für Tier `premium` |
| `SUPABASE_URL` | von Supabase automatisch gesetzt |
| `SUPABASE_SERVICE_ROLE_KEY` | von Supabase automatisch gesetzt — Webhook schreibt damit |
| `APP_DEEP_LINK_SUCCESS` | z.B. `cheffity://subscription/success` (Checkout return_url) |
| `APP_DEEP_LINK_CANCEL` | z.B. `cheffity://subscription/cancel` |

> Das App-Scheme `cheffity` ist in `mobile/app.json` bereits gesetzt.

### Mobile (`.env` / `app.json` → `extra`, Prefix `EXPO_PUBLIC_`)
Bei Hosted Checkout wird **kein** Stripe-Publishable-Key auf dem Client
gebraucht. Nur die Function-URLs sind nötig — die laufen ohnehin über die
bekannte Supabase-URL. → **keine neuen Client-Secrets.**

### `.env.example` (Root)
Bereits vorhanden: `STRIPE_PUBLIC_KEY`, `STRIPE_SECRET_KEY`. Ergänzen um
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_PREMIUM` (als
Doku-Platzhalter; echte Werte gehören in Supabase-Secrets, nicht ins Repo).

---

## 6. Edge Functions im Detail

### `stripe-checkout` (aufgerufen vom SubscriptionScreen)
1. JWT des Users aus `Authorization`-Header verifizieren → `user_id`, `email`.
2. `subscriptions`-Zeile lesen. Falls `stripe_customer_id` leer →
   `stripe.customers.create({ email, metadata: { user_id } })`, ID in der
   Zeile speichern.
3. `stripe.checkout.sessions.create({ mode: 'subscription', customer,
   line_items: [{ price: STRIPE_PRICE_<TIER>, quantity: 1 }],
   success_url, cancel_url, metadata: { user_id, tier } })`.
4. `{ url }` zurückgeben. App öffnet URL via `expo-web-browser`.

### `stripe-portal`
1. JWT verifizieren → `user_id`.
2. `stripe_customer_id` aus `subscriptions` lesen (muss existieren).
3. `stripe.billingPortal.sessions.create({ customer, return_url })`.
4. `{ url }` zurückgeben.

### `stripe-webhook` (aufgerufen von Stripe, **kein** JWT)
1. `verify_jwt = false` in `supabase/config.toml` für diese Function.
2. Rohen Body + `Stripe-Signature`-Header mit `STRIPE_WEBHOOK_SECRET`
   prüfen (`stripe.webhooks.constructEventAsync` — async-Variante für Deno).
3. Event-Typ behandeln (Abschnitt 8) → mit `service_role`-Client die
   passende `subscriptions`-Zeile updaten (`tier`, `status`,
   `stripe_subscription_id`, `current_period_*`, `cancel_at_period_end`).
   User-Zuordnung über `customer`-ID bzw. `metadata.user_id`.
4. Immer `200` zurückgeben (sonst retryt Stripe). Fehler intern loggen.
5. Idempotent bleiben: Events können doppelt kommen → Update statt Insert,
   ggf. `event.id` gegen eine kleine `stripe_events`-Tabelle prüfen (optional).

---

## 7. DB-Änderungen

**Im Normalfall keine** — die `subscriptions`-Tabelle deckt alles ab.

Optional (nur falls gewünscht):
- Neue Migration `..._stripe_events.sql` mit Tabelle `stripe_events (id text
  primary key, processed_at timestamptz)` für Webhook-Idempotenz.
- **Keine** bestehende Migration bearbeiten — immer neue Migration (Projektregel).
- Das Price-ID → Tier-Mapping bleibt in Env Vars, **keine** DB-Tabelle nötig.

---

## 8. Webhook-Events, die behandelt werden müssen

| Event | Aktion auf `subscriptions` |
|---|---|
| `checkout.session.completed` | `stripe_subscription_id` + `stripe_customer_id` setzen, `tier` aus `metadata.tier`, `status='active'` |
| `customer.subscription.updated` | `status`, `cancel_at_period_end`, `current_period_*`, ggf. `tier` (bei Plan-Wechsel über Portal) aktualisieren |
| `customer.subscription.deleted` | `tier='free'`, `status='canceled'`, Stripe-IDs ggf. behalten für Historie |
| `invoice.payment_failed` | `status='past_due'` (App kann darauf reagieren) |
| `invoice.paid` | `status='active'`, `current_period_end` verlängern |

Tier-Ableitung bei `subscription.updated`: über die Price-ID des Sub-Items
gegen `STRIPE_PRICE_PLUS` / `STRIPE_PRICE_PREMIUM` mappen.

---

## 9. Mobile-Änderungen (`SubscriptionScreen.tsx`)

- `handleSubscribe(tier)` (aktuell TODO):
  1. `supabase.functions.invoke('stripe-checkout', { body: { tier } })`.
  2. `WebBrowser.openBrowserAsync(url)` (`expo-web-browser`).
  3. Nach Rückkehr nichts weiter tun — `SubscriptionContext` bekommt das
     Update via Realtime. Optional: kurzer Lade-/Hinweis-State.
- Neuer Button "Abo verwalten" (nur wenn `tier !== 'free'`) →
  `stripe-portal` analog.
- Fehlerfälle über `Alert` + i18n-Keys (neue Keys in `de` **und** `en`).
- Deep-Link-Handling für `success`/`cancel` ist optional (Realtime reicht);
  falls gewünscht, `expo-linking`-Listener ergänzen.

---

## 10. Was vorher gebraucht wird (nicht blind starten)

Bevor Code geschrieben wird, müssen vorliegen / geklärt sein:
1. **Stripe-Account** vorhanden? Test-Mode reicht für die erste Umsetzung.
2. **Produkte + Preise** im Dashboard angelegt → die zwei `price_...`-IDs.
3. **`sk_test_...`** Secret Key.
4. **Webhook-Endpoint** angelegt → `whsec_...`.
5. Entscheidung **Plan-Wechsel**: über Customer Portal (empfohlen, einfach)
   oder eigener Upgrade/Downgrade-Flow?
6. Entscheidung **Proration** bei Tier-Wechsel (Stripe-Default vs. eigene Regel).
7. Bestätigung der Architektur (Edge Functions + Hosted Checkout) — falls
   stattdessen native In-App-Bezahlung gewünscht ist, ändert sich der Plan
   grundlegend (Apple/Google verlangen dann ggf. IAP statt Stripe!).
   ⚠️ **App-Store-Risiko klären:** Apple/Google können für digitale Abos
   In-App-Purchase verlangen. Das ist eine Produktentscheidung, kein Code-Thema.

---

## 11. Empfohlene Umsetzungsreihenfolge

1. Stripe-Dashboard-Setup + Secrets setzen (Abschnitt 4–5).
2. `stripe-webhook` zuerst — mit Stripe CLI (`stripe listen --forward-to ...`)
   lokal testen, bis `subscriptions` korrekt geschrieben wird.
3. `stripe-checkout` + Wiring in `SubscriptionScreen.handleSubscribe`.
4. `stripe-portal` + "Abo verwalten"-Button.
5. End-to-End-Test im Stripe-Test-Mode (Testkarten), inкл. Kündigung.
6. i18n-Keys (`de`+`en`) für alle neuen Strings.
7. Live-Mode-Keys/Preise erst nach erfolgreichem Test-Mode-Durchlauf.

---

## 12. Tests

- **Stripe CLI** für Webhook-Events (`stripe trigger checkout.session.completed`).
- Edge Functions: kleine Unit-Tests für das Price-ID→Tier-Mapping und die
  Event-Handler-Logik (reine Funktionen herausziehen, damit testbar).
- Manueller E2E-Durchlauf im Test-Mode mit Stripe-Testkarte `4242...`.
- Regression: `SubscriptionContext` schaltet nach Webhook-Update live um.

---

## 13. Implementierungs-Status (Stand 2026-05-14)

### Umgesetzt
- **Migration** `supabase/migrations/20260514000001_stripe_events.sql` —
  `public.stripe_events` (Idempotenz). RLS an, keine Policies → nur
  `service_role` schreibt. (Im Plan war die Tabelle als „optional“ vermerkt;
  jetzt fest umgesetzt.)
- **Edge Functions** unter `supabase/functions/`:
  - `_shared/http.ts`, `_shared/supabase.ts`, `_shared/stripe.ts` — geteilte Helfer.
  - `stripe-checkout/index.ts`, `stripe-portal/index.ts`, `stripe-webhook/index.ts`.
  - Stripe-SDK via `https://esm.sh/stripe@17?target=deno` (nur serverseitig).
- **`supabase/config.toml`** — `[functions.stripe-webhook] verify_jwt = false`,
  `stripe-checkout`/`stripe-portal` explizit `verify_jwt = true`.
- **Mobile** — `mobile/src/services/subscriptionApi.ts`
  (`startStripeCheckout`, `openStripePortal`, `EXTERNAL_STRIPE_CHECKOUT_ENABLED`)
  und `SubscriptionScreen.tsx` (`handleSubscribe`, „Abo verwalten“-Button,
  Env-Flag-Gate, Lade-/Hinweis-States). Keine Secrets in Mobile.
- **i18n** — neue Keys unter `subscription.checkout.*` in `de` + `en`.
- **Env-Doku** — `.env.example` (Root) und `mobile/.env.example` ergänzt.

### Bewusste Abweichungen vom Plan
- **Webhook-Statuscodes:** Plan §6.4 sagte „immer 200“. Stattdessen:
  200 bei Erfolg/Duplikat, 400 bei Signatur-/Configfehler, **500 bei
  Handler-Fehler** → Stripe retryt mit Backoff, das Event wird *nicht*
  als verarbeitet markiert. „Immer 200“ würde fehlgeschlagene
  Subscription-Updates still verschlucken.
- **Idempotenz-Reihenfolge:** erst `stripe_events` prüfen → Event behandeln →
  **danach** die Event-ID schreiben (nicht vorher). So wird ein
  fehlgeschlagener Handler beim Retry erneut ausgeführt.
- **Externer Checkout per Env-Flag aus:** Mobile ruft `stripe-checkout`/
  `stripe-portal` nur auf, wenn `EXPO_PUBLIC_ENABLE_EXTERNAL_STRIPE_CHECKOUT=true`.
  Ohne Flag zeigt der Screen einen Hinweis und deaktivierte Buttons —
  kein externer Zahlungs-Flow in Store-/Release-Builds.

### Offen (manuell, vor Go-Live)
- Stripe-Dashboard: Produkte/Preise, Customer Portal, Webhook-Endpoint
  (Abschnitt 4).
- Secrets setzen: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_PREMIUM`, `APP_DEEP_LINK_SUCCESS`,
  `APP_DEEP_LINK_CANCEL` (Abschnitt 5).
- ⚠️ **`success_url`/`cancel_url`:** Stripe Checkout akzeptiert i.d.R. nur
  `http(s)`-URLs. Falls ein App-Scheme-Deep-Link (`cheffity://…`) abgelehnt
  wird, in `APP_DEEP_LINK_*` eine https-Bounce-Seite eintragen, die ins
  App-Scheme weiterleitet. Der Function-Code liest die Werte nur aus Env —
  reine Ops-/Konfig-Entscheidung.
- Stripe-SDK-Version (`stripe@17`) bei Bedarf anheben; `current_period_*`
  wird sowohl auf Subscription- als auch Item-Ebene gelesen (API-Versions-robust).
- Test-Mode-E2E-Durchlauf (Abschnitt 11/12).
- Produktentscheidung App-Store-IAP (Abschnitt 10.7) — bleibt bewusst offen.
