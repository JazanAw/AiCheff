import { Placeholder } from '../components/Placeholder';

export function SettingsPage() {
  return (
    <Placeholder
      title="Einstellungen"
      description="System-, API- und Feature-Konfiguration."
      sections={[
        'Admin-Konten verwalten (hinzufügen, entfernen, Rolle ändern)',
        'API-Keys (Marktguru, Kaufda, TheMealDB, Stripe, Claude, Ollama)',
        'AI-Provider umschalten (Ollama lokal ↔ Claude API)',
        'App-Version-Verwaltung',
        'Feature-Flags (ohne Redeploy ein-/ausschalten)',
      ]}
    />
  );
}
