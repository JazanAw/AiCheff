export interface Country {
  code: string;       // ISO-3166 alpha-2
  name: string;       // German display name (fallback for all locales)
  dialCode: string;   // E.164 dial code with leading +
  flag: string;       // Unicode flag emoji
}

export const COUNTRIES: Country[] = [
  { code: 'DE', name: 'Deutschland',   dialCode: '+49',  flag: '🇩🇪' },
  { code: 'AT', name: 'Österreich',    dialCode: '+43',  flag: '🇦🇹' },
  { code: 'CH', name: 'Schweiz',       dialCode: '+41',  flag: '🇨🇭' },
  { code: 'TR', name: 'Türkei',        dialCode: '+90',  flag: '🇹🇷' },
  { code: 'IT', name: 'Italien',       dialCode: '+39',  flag: '🇮🇹' },
  { code: 'ES', name: 'Spanien',       dialCode: '+34',  flag: '🇪🇸' },
  { code: 'PL', name: 'Polen',         dialCode: '+48',  flag: '🇵🇱' },
  { code: 'FR', name: 'Frankreich',    dialCode: '+33',  flag: '🇫🇷' },
  { code: 'GB', name: 'Großbritannien', dialCode: '+44', flag: '🇬🇧' },
  { code: 'NL', name: 'Niederlande',   dialCode: '+31',  flag: '🇳🇱' },
  { code: 'BE', name: 'Belgien',       dialCode: '+32',  flag: '🇧🇪' },
  { code: 'PT', name: 'Portugal',      dialCode: '+351', flag: '🇵🇹' },
  { code: 'GR', name: 'Griechenland',  dialCode: '+30',  flag: '🇬🇷' },
  { code: 'DK', name: 'Dänemark',      dialCode: '+45',  flag: '🇩🇰' },
  { code: 'SE', name: 'Schweden',      dialCode: '+46',  flag: '🇸🇪' },
  { code: 'NO', name: 'Norwegen',      dialCode: '+47',  flag: '🇳🇴' },
  { code: 'FI', name: 'Finnland',      dialCode: '+358', flag: '🇫🇮' },
  { code: 'IE', name: 'Irland',        dialCode: '+353', flag: '🇮🇪' },
  { code: 'US', name: 'USA',           dialCode: '+1',   flag: '🇺🇸' },
  { code: 'CA', name: 'Kanada',        dialCode: '+1',   flag: '🇨🇦' },
];

export const DEFAULT_COUNTRY: Country = COUNTRIES[0]; // Deutschland

export function findCountry(code: string): Country | undefined {
  return COUNTRIES.find((c) => c.code === code);
}
