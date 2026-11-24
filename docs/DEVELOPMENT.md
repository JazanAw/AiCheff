# AIChef

AIChef ist eine App mit 3 Tabs:
- `Angebote`: Wochenangebote laden, filtern, zu Einkaufsliste hinzufuegen.
- `Liste`: Einkaufsliste verwalten.
- `AIChef`: Rezeptvorschlaege aus Angeboten und Praeferenzen.

Die Angebotsermittlung laeuft im **Backend** und nicht in der App.

## Start

```bash
npm install
npm run dev
```

`npm run dev` startet:
- Frontend (Vite) auf `http://localhost:5173`
- Offers-Backend auf `http://localhost:8787`

Fuer Handy im gleichen WLAN:

```bash
# einmalig in .env: BIND_HOST=0.0.0.0
npm run dev:mobile
```

Dann `http://<PC-IP>:5173` auf dem Handy aufrufen.

**Wichtig:** Das Backend bindet standardmaessig nur an `127.0.0.1` und ist
damit vom Handy aus NICHT erreichbar. Erst `BIND_HOST=0.0.0.0` in der `.env`
oeffnet es fuers WLAN. Grund fuer den sicheren Default: der Backend-Prozess
hat keine Authentifizierung und haelt den Supabase-Service-Role-Key — mit
`0.0.0.0` kann jeder im selben Netz `/admin-v2` oeffnen, Scans starten und
das Backend herunterfahren. Nach den Handy-Tests wieder auskommentieren.

## ENV

Lege eine `.env` anhand `.env.example` an:

```env
VITE_BACKEND_BASE_URL=http://localhost:8787
VITE_OLLAMA_HOST=http://localhost:11434
VITE_OLLAMA_MODEL=llama3.1
VITE_USE_FIXTURE_OFFERS=false
VITE_MARKTGURU_DEFAULT_ZIP=10115
VITE_MARKTGURU_WEEK_MODE=overlap
VITE_MARKTGURU_MAX_VALIDITY_DAYS=21
```

Angebote werden standardmaessig aus dem Marktguru-Datenfeed geladen.
Nur wenn `VITE_USE_FIXTURE_OFFERS=true` gesetzt ist, werden Demo-Angebote verwendet.

## Backend API (Offers)

- `GET /api/health`
- `GET /api/offers`
- `GET /api/offers/filtered`
- `GET /api/offers/filter-list`
- `POST /api/offers/filter-list/blocked/add`
- `POST /api/offers/filter-list/blocked/remove`
- `POST /api/offers/filter-list/reset`
- `POST /api/offers/live-to-filtered`
- `POST /api/offers/filtered-to-live`
- `POST /api/offers/clear`
- `POST /api/offers/filter-food`
- `POST /api/offers/rescan-food-ai`
- `POST /api/offers/rescan-food-ai/start`
- `GET /api/offers/rescan-food-ai/status`
- `POST /api/offers/refresh`
- `POST /api/offers/one-click-sync`
- `POST /api/offers/one-click-ai-live`
- `POST /api/offers/one-click-ai-live/start`
- `GET /api/offers/one-click-ai-live/status`
- `GET /api/debug/state`
- `GET /api/debug/logs?limit=200`
- `GET /api/system/status`
- `GET /api/system/ollama/pull-status`
- `POST /api/system/ollama/pull`
- `POST /api/system/start/ollama`
- `POST /api/system/start/app`
- `POST /api/system/stop/ollama`
- `POST /api/system/stop/app`

Dashboard mit Buttons:
- `http://localhost:8787/`
- inkl. One-Click-Button: `Angebote ermitteln + App anzeigen`
- inkl. One-Click-KI-Button: `Alles neu + KI + App Start`
- One-Click-KI laeuft asynchron mit Live-Status (stage + Fortschritt)
- inkl. eigenem `Debug`-Tab (nur im Backend-Dashboard)
- `Rausfiltern` und `Zu Live` trainieren den strengen Lebensmittel-Filter automatisch
- `KI Neu-Scan Lebensmittel` startet Ollama automatisch vor dem Scan
- `KI Neu-Scan Lebensmittel` zeigt Fortschritt live (`x/y`)
- Header-Button `Modell laden (ollama pull)` startet `ollama pull` fuer das konfigurierte Modell

## Skripte

```bash
npm run dev
npm run dev:client
npm run dev:mobile
npm run dev:client:mobile
npm run dev:server
npm run mobile:start
npm run mobile:android
npm run mobile:ios
npm run mobile:typecheck
npm run mobile:build:android
npm run mobile:build:ios
npm run start:server
npm run build
npm run lint
npm test
```

## Native App (Expo)

Im Ordner `mobile/` liegt jetzt eine echte Expo App (kein Browser-Frontend).

### Lokaler Start auf dem Handy

```bash
cd mobile
npm install
cp .env.example .env
# set EXPO_PUBLIC_BACKEND_BASE_URL=http://<PC-IP>:8787
npm start
```

Dann in Expo Go den QR-Code scannen.

Parallel muss das Backend laufen:

```bash
npm run dev:server
```

### Spaeter Store Release (App Store / Google Play)

```bash
cd mobile
npx eas login
npx eas build:configure
npm run build:android
npm run build:ios
```

## Offers CLI (Python)

Ermittelt aus mehreren Snapshot-JSONs die nationalen Lebensmittel-Angebote der Woche.

### Voraussetzungen

- Python 3.11+
- `pytest` (fuer Tests)

### Start

```bash
python -m offers_tool --input ./data --out ./out
```

### Wichtige Flags

```bash
python -m offers_tool \
  --input ./data \
  --out ./out \
  --national-threshold 0.80 \
  --mode overlap
```

```bash
python -m offers_tool \
  --input ./data \
  --out ./out \
  --mode starts \
  --drop-ussegl \
  --keywords-file ./extra_keywords.txt
```

### Output-Dateien

- `./out/national_food_offers.json`
- `./out/flagged_nonfood.json`
- `./out/flagged_out_of_week.json` (nur bei `--mode starts`)
- `./out/summary.md`

### Tests

```bash
python -m pytest -q
```

## AICheff Offers Pipeline (Python)

Neue Pipeline fuer:
- Angebote der Woche inkl. Midweek-Flags (nicht gefiltert)
- Food/Non-Food/Unsure Markierung
- Haupt-/Unterkategorie
- optional National-Coverage ueber mehrere Snapshot-Dateien
- Nutrition + Allergene + Diet/Halal-Enrichment mit OFF/BLS

### BLS Starter-Daten

```bash
python -m aichef_offers download-bls --out ./data/bls
```

### Run

```bash
python -m aichef_offers \
  --input ./data \
  --out ./out \
  --mode overlap \
  --ollama off \
  --national on \
  --nutrition on \
  --nutrition-source both \
  --diet on \
  --halal on \
  --dump-stats
```

### Wichtige Flags

```bash
--week-start YYYY-MM-DD
--week-window calendar|retail
--week-end-day mon|tue|wed|thu|fri|sat|sun
--national-threshold 0.80
--min-rule-score 3.0
--nutrition-source off|bls|both
--max-off-req-per-min 80
--veg-implies-halal true|false
```

### Eval

```bash
python -m aichef_offers eval \
  --input ./data \
  --out ./out_eval \
  --mode overlap \
  --week-window calendar \
  --ollama off \
  --dump-stats
```

### Outputs

- `all_in_week.json` 
- `food_in_week.json`
- `flagged_nonfood.json`
- `flagged_midweek.json`
- `debug_low_confidence.json`
- `flagged_halal_no.json`
- `flagged_gelatin_unknown.json`
- `summary.md`
- `stats.json` (bei `--dump-stats`)
- `category_suspects.json` (bei `eval`)
- `eval_stats.json` (bei `eval --dump-stats`)

## Expo Go im LAN (PowerShell)

```powershell
cd mobile
$env:REACT_NATIVE_PACKAGER_HOSTNAME="<PC-IP>"
npx expo start --go --lan --port 8081
```
