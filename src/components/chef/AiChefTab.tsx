import { Offer, Recipe, UserPreferences } from '../../types/models';
import { RecipeCard } from './RecipeCard';
import { UserPreferencesForm } from './UserPreferencesForm';

interface AiChefTabProps {
  offers: Offer[];
  recipes: Recipe[];
  preferences: UserPreferences;
  loading: boolean;
  error: string | null;
  warnings: string[];
  onPreferencesChange: (next: UserPreferences) => void;
  onGenerateRecipes: () => Promise<void>;
  onAddRecipeIngredients: (recipeId: string) => void;
}

export function AiChefTab({
  offers,
  recipes,
  preferences,
  loading,
  error,
  warnings,
  onPreferencesChange,
  onGenerateRecipes,
  onAddRecipeIngredients,
}: AiChefTabProps) {
  return (
    <div className="tab-layout">
      <section className="hero-panel">
        <p className="eyebrow">Tab 3</p>
        <h2>AIChef</h2>
        <p className="small-copy">
          Rezepte basieren auf Wochenangeboten und deinen Praeferenzen.
        </p>
        <button
          type="button"
          className="primary-button"
          onClick={() => onGenerateRecipes()}
          disabled={loading}
        >
          {loading ? 'Generiert...' : 'Rezeptvorschlaege laden'}
        </button>
        <p className="small-copy">
          Copyright: keine Volltexte aus geschuetzten Kochbuechern verwenden.
        </p>
        {error ? <p className="status error">{error}</p> : null}
        {warnings.length > 0 ? (
          <div className="status warning">
            {warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}
      </section>

      <UserPreferencesForm preferences={preferences} onChange={onPreferencesChange} />

      <section className="panel">
        <h3>Rezeptvorschlaege</h3>
        {offers.length === 0 ? (
          <p className="empty-state">
            Keine Angebotsdaten vorhanden. Bitte zuerst in Tab 1 Angebote laden.
          </p>
        ) : null}
        {offers.length > 0 && recipes.length === 0 ? (
          <p className="empty-state">
            Noch keine Rezepte generiert. Klicke auf "Rezeptvorschlaege laden".
          </p>
        ) : null}
        <div className="recipe-grid">
          {recipes.map((recipe) => (
            <RecipeCard
              key={recipe.id}
              recipe={recipe}
              onAddIngredients={onAddRecipeIngredients}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
