# Cheffity Mobile (Expo)

## Start

```bash
cd mobile
npm install
cp .env.example .env
# Supabase Keys und AI Provider in .env eintragen
npm start
```

Dann in Expo Go den QR-Code scannen.

## ENV

```env
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_AI_PROVIDER=local
EXPO_PUBLIC_OLLAMA_HOST=http://localhost:11434
EXPO_PUBLIC_OLLAMA_MODEL=qwen2.5:14b
EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=your-stripe-key
```

## Build

```bash
npx eas login
npx eas build:configure
npm run build:android
npm run build:ios
```
