import { Recipe } from '../../types/models';

interface RecipeCardProps {
  recipe: Recipe;
  onAddIngredients: (recipeId: string) => void;
}

export function RecipeCard({ recipe, onAddIngredients }: RecipeCardProps) {
  return (
    <article className="recipe-card">
      <div className="panel-header">
        <h4>{recipe.name}</h4>
        <button type="button" className="secondary-button" onClick={() => onAddIngredients(recipe.id)}>
          Zutaten zur Liste
        </button>
      </div>
      <p className="small-copy">
        {recipe.servings} Portionen · {recipe.timeMinutes} Minuten
      </p>

      <h5>Zutaten</h5>
      <ul className="recipe-list">
        {recipe.ingredients.map((ingredient) => (
          <li key={ingredient.id} className={ingredient.missing ? 'missing' : ''}>
            {ingredient.amount} {ingredient.unit} {ingredient.name}
            {ingredient.missing ? ' (fehlend)' : ''}
          </li>
        ))}
      </ul>

      {recipe.missingIngredients.length > 0 ? (
        <>
          <h5>Fehlende Zutaten</h5>
          <ul className="recipe-list missing-list">
            {recipe.missingIngredients.map((ingredient) => (
              <li key={`${recipe.id}_${ingredient.id}`}>{ingredient.name}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h5>Anleitung</h5>
      <ol className="recipe-list">
        {recipe.instructions.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </article>
  );
}
