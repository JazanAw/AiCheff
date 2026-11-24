import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';

import de from './locales/de';
import en from './locales/en';
import tr from './locales/tr';
import it from './locales/it';
import es from './locales/es';
import pl from './locales/pl';

const resources = {
  de: { translation: de },
  en: { translation: en },
  tr: { translation: tr },
  it: { translation: it },
  es: { translation: es },
  pl: { translation: pl },
};

const supportedLanguages = ['de', 'en', 'tr', 'it', 'es', 'pl'];

function getDeviceLanguage(): string {
  const locale = Localization.getLocales()[0]?.languageCode ?? 'de';
  return supportedLanguages.includes(locale) ? locale : 'de';
}

i18n.use(initReactI18next).init({
  resources,
  lng: getDeviceLanguage(),
  fallbackLng: 'de',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
