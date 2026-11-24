import { Placeholder } from '../components/Placeholder';

export function UsersPage() {
  return (
    <Placeholder
      title="Nutzer"
      description="Nutzer-Verwaltung mit Tier-Steuerung und Account-Aktionen."
      sections={[
        'Tabelle: E-Mail, Tier, Beitritt, zuletzt aktiv, Land',
        'Suche und Filter (Tier, Datum, Land)',
        'Nutzer-Details (Subscription, Swipe-Historie, Wochenplan)',
        'Tier manuell setzen (Free / Plus / Premium)',
        'Account sperren oder löschen',
      ]}
    />
  );
}
