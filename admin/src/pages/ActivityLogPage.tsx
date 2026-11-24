import { Placeholder } from '../components/Placeholder';

export function ActivityLogPage() {
  return (
    <Placeholder
      title="Aktivitäts-Log"
      description="Alle Admin-Aktionen mit Zeitstempel und ausführendem Konto."
      sections={[
        'Tabelle: Zeit, Admin, Aktion, Ziel, Payload',
        'Filter nach Admin, Aktion, Ziel-Tabelle, Zeitraum',
        'Detail-Ansicht je Eintrag',
        'CSV-Export',
      ]}
    />
  );
}
