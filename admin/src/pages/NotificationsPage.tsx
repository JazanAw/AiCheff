import { Placeholder } from '../components/Placeholder';

export function NotificationsPage() {
  return (
    <Placeholder
      title="Benachrichtigungen"
      description="Push-Notifications komponieren, planen und versenden."
      sections={[
        'Zielgruppe wählen (Alle, Free, Plus, Premium, Region)',
        'Titel + Nachricht (mehrsprachig)',
        'Sofort versenden oder zeitlich planen',
        'Versand-Historie',
      ]}
    />
  );
}
