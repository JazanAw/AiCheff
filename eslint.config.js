import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // dist = Build-Artefakt. admin/ ist ein eigenständiges Vite-Projekt mit
  // eigener eslint.config.js + "lint"-Script → wird nicht vom Root mitgelintet.
  // .tmp = Temp-Artefakt (z.B. pytest-Basetemp) — enthält keinen Quellcode und
  // darf den Lint-Lauf nicht durch gesperrte Verzeichnisse zum Absturz bringen.
  globalIgnores(['dist', 'admin', '.tmp']),

  // Basis-Regeln für Web-MVP (src/), Backend (backend/) und Mobile (mobile/).
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },

  // React-Native-spezifische Anpassungen: die oben geerbten Web-MVP-Regeln
  // passen nicht 1:1 auf die Expo-App in mobile/. Hier werden nur die Regeln
  // entschärft, die in idiomatischem React-Native-Code False Positives erzeugen.
  {
    files: ['mobile/**/*.{ts,tsx}'],
    rules: {
      // useRef(new Animated.Value()) + .interpolate() im Render ist das
      // offizielle RN-Animationsmuster. Die react-hooks-v7-Regel "refs" kennt
      // Animated.Value nicht und meldet hier ausschließlich False Positives.
      'react-hooks/refs': 'off',
      // require('./asset.png') ist in React Native der idiomatische Weg,
      // statische Bild-/Font-Assets zu laden — es gibt kein ES-Import-Äquivalent
      // für <Image source={...} />.
      '@typescript-eslint/no-require-imports': 'off',
      // Context-Dateien (AuthContext, …) exportieren bewusst Provider + Hook
      // zusammen. Die Regel ist Vite-Fast-Refresh-spezifisch und gilt für die
      // Expo/Metro-Toolchain nicht.
      'react-refresh/only-export-components': 'off',
      // setState am Effekt-Anfang (z.B. setLoading(true)) wird hier bewusst
      // genutzt. Bleibt als Warnung sichtbar, ist aber kein Release-Blocker.
      'react-hooks/set-state-in-effect': 'warn',
      // Ein '_'-Präfix kennzeichnet bewusst ungenutzte Parameter/Variablen.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
])
