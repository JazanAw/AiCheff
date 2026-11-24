import { ChangeEvent } from 'react';
import { UserPreferences } from '../../types/models';

interface UserPreferencesFormProps {
  preferences: UserPreferences;
  onChange: (next: UserPreferences) => void;
}

function stringListToInput(value: string[]): string {
  return value.join(', ');
}

function inputToStringList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function UserPreferencesForm({
  preferences,
  onChange,
}: UserPreferencesFormProps) {
  const onCheckbox =
    (key: keyof Pick<UserPreferences, 'vegetarian' | 'vegan' | 'halal'>) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({
        ...preferences,
        [key]: event.target.checked,
      });
    };

  return (
    <section className="panel">
      <h3>Präferenzen</h3>
      <div className="preference-grid">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={preferences.vegetarian}
            onChange={onCheckbox('vegetarian')}
          />
          Vegetarisch
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={preferences.vegan} onChange={onCheckbox('vegan')} />
          Vegan
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={preferences.halal} onChange={onCheckbox('halal')} />
          Halal
        </label>
      </div>

      <label>
        Allergien (kommagetrennt)
        <input
          type="text"
          placeholder="z.B. Nüsse, Sellerie"
          value={stringListToInput(preferences.allergies)}
          onChange={(event) =>
            onChange({
              ...preferences,
              allergies: inputToStringList(event.target.value),
            })
          }
        />
      </label>

      <label>
        No-Go Zutaten (kommagetrennt)
        <input
          type="text"
          placeholder="z.B. Koriander"
          value={stringListToInput(preferences.noGoIngredients)}
          onChange={(event) =>
            onChange({
              ...preferences,
              noGoIngredients: inputToStringList(event.target.value),
            })
          }
        />
      </label>
    </section>
  );
}
