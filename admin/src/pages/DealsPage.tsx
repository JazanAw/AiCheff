import { Placeholder } from '../components/Placeholder';

export function DealsPage() {
  return (
    <Placeholder
      title="Angebote"
      description="Aktuelle Wochenangebote, Verifizierung und Scan-Trigger."
      sections={[
        'Liste aller aktuellen Wochenangebote',
        'Filter nach Laden, Kategorie, Region',
        'Anzeigen: welche Angebote sind Rezepten zugeordnet',
        'Angebot als verifiziert markieren oder flaggen',
        'Manuellen Scan-Lauf starten · letzte Scans + Status',
      ]}
    />
  );
}
