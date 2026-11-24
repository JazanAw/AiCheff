import { z } from 'zod';
import { appConfig } from '../../config/env';
import {
  Offer,
  Recipe,
  RecipeIngredient,
  ShoppingListItem,
  UserPreferences,
} from '../../types/models';
import { normalizeText } from '../../utils/offers';
import { ollamaChat } from '../ollama';

const rawRecipeSchema = z.object({
  name: z.string(),
  servings: z.number(),
  timeMinutes: z.number(),
  instructions: z.array(z.string()),
  ingredients: z.array(
    z.object({
      name: z.string(),
      amount: z.number(),
      unit: z.string(),
    }),
  ),
});

const rawRecipeEnvelopeSchema = z.union([
  z.array(rawRecipeSchema),
  z.object({ recipes: z.array(rawRecipeSchema) }),
]);

function stableId(prefix: string, payload: string): string {
  let hash = 0;
  for (let index = 0; index < payload.length; index += 1) {
    hash = (hash << 5) - hash + payload.charCodeAt(index);
    hash |= 0;
  }
  return `${prefix}_${Math.abs(hash).toString(36)}`;
}

function parseOllamaRecipeResponse(responseText: string): z.infer<typeof rawRecipeSchema>[] {
  const trimmed = responseText.trim();
  const jsonPayload = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    : trimmed;
  const parsed = JSON.parse(jsonPayload) as unknown;
  const validation = rawRecipeEnvelopeSchema.safeParse(parsed);
  if (!validation.success) {
    return [];
  }

  return Array.isArray(validation.data)
    ? validation.data
    : validation.data.recipes;
}

function ingredientFromOffer(offer: Offer, amount = 1): RecipeIngredient {
  return {
    id: stableId('ingredient', `${offer.id}_${amount}`),
    name: offer.name,
    normalizedName: offer.normalizedName,
    amount,
    unit: offer.unit,
    missing: false,
    matchedOfferId: offer.id,
  };
}

function normalizedOfferCategory(offer: Offer): string {
  return normalizeText(offer.category);
}

function offerMatchesPreferences(offer: Offer, preferences: UserPreferences): boolean {
  const category = normalizedOfferCategory(offer);

  if (
    preferences.vegan &&
    !offer.tags.includes('vegan') &&
    !category.includes('obst') &&
    !category.includes('gemuse')
  ) {
    return false;
  }

  if (
    preferences.vegetarian &&
    !preferences.vegan &&
    category.includes('fleisch')
  ) {
    return false;
  }

  if (preferences.halal && category.includes('schwein')) {
    return false;
  }

  const noGoSet = new Set(preferences.noGoIngredients.map((item) => normalizeText(item)));
  if (noGoSet.has(offer.normalizedName)) {
    return false;
  }

  return true;
}

function mapMissingIngredients(recipe: Recipe, offers: Offer[]): Recipe {
  const offerByNormalizedName = new Map<string, Offer>();
  for (const offer of offers) {
    offerByNormalizedName.set(offer.normalizedName, offer);
  }

  const ingredients = recipe.ingredients.map((ingredient) => {
    const directMatch = offerByNormalizedName.get(ingredient.normalizedName);
    if (directMatch) {
      return {
        ...ingredient,
        missing: false,
        matchedOfferId: directMatch.id,
      };
    }

    const fuzzyMatch = offers.find(
      (offer) =>
        offer.normalizedName.includes(ingredient.normalizedName) ||
        ingredient.normalizedName.includes(offer.normalizedName),
    );

    if (fuzzyMatch) {
      return {
        ...ingredient,
        missing: false,
        matchedOfferId: fuzzyMatch.id,
      };
    }

    return {
      ...ingredient,
      missing: true,
      matchedOfferId: undefined,
    };
  });

  return {
    ...recipe,
    ingredients,
    missingIngredients: ingredients.filter((ingredient) => ingredient.missing),
  };
}

function buildFallbackRecipes(offers: Offer[]): Recipe[] {
  const vegetables = offers.filter((offer) => {
    const category = normalizedOfferCategory(offer);
    return category.includes('obst') || category.includes('gemuse');
  });
  const proteins = offers.filter((offer) =>
    ['fleisch', 'fisch', 'milchprodukte', 'milchalternativen'].some((token) =>
      normalizedOfferCategory(offer).includes(token),
    ),
  );
  const carbs = offers.filter((offer) =>
    ['trockenware', 'konserven'].some((token) =>
      normalizedOfferCategory(offer).includes(token),
    ),
  );

  const fallbackTemplates = [
    {
      name: 'Wochengericht: Gemüse-Reis-Pfanne',
      instructions: [
        'Gemüse putzen und grob schneiden.',
        'Reis nach Packungsangabe kochen.',
        'Gemüse anbraten, würzen und mit Reis vermengen.',
      ],
      servings: 2,
      timeMinutes: 25,
      ingredients: [
        vegetables[0],
        vegetables[1],
        carbs[0],
      ].filter(Boolean) as Offer[],
      pantry: [{ name: 'Olivenöl', amount: 2, unit: 'EL' }],
    },
    {
      name: 'Wochengericht: Protein-Bowl',
      instructions: [
        'Proteinquelle anbraten oder garen.',
        'Gemüse roh oder kurz blanchiert vorbereiten.',
        'Alles in einer Bowl mit Dressing servieren.',
      ],
      servings: 2,
      timeMinutes: 20,
      ingredients: [proteins[0], vegetables[0], carbs[1] ?? carbs[0]].filter(
        Boolean,
      ) as Offer[],
      pantry: [{ name: 'Zitronensaft', amount: 1, unit: 'EL' }],
    },
    {
      name: 'Wochengericht: Schnelle Pasta',
      instructions: [
        'Nudeln kochen.',
        'Gemüse in der Pfanne anschwitzen.',
        'Mit Joghurt oder Haferdrink cremig binden und abschmecken.',
      ],
      servings: 3,
      timeMinutes: 30,
      ingredients: [carbs[0], vegetables[0], proteins[1] ?? proteins[0]].filter(
        Boolean,
      ) as Offer[],
      pantry: [{ name: 'Knoblauch', amount: 1, unit: 'Zehe' }],
    },
  ];

  return fallbackTemplates.map((template) => {
    const offerIngredients = template.ingredients.map((offer) =>
      ingredientFromOffer(offer),
    );
    const pantryIngredients: RecipeIngredient[] = template.pantry.map((item) => ({
      id: stableId('ingredient', `${template.name}_${item.name}`),
      name: item.name,
      normalizedName: normalizeText(item.name),
      amount: item.amount,
      unit: item.unit,
      missing: true,
    }));
    const allIngredients = [...offerIngredients, ...pantryIngredients];

    return {
      id: stableId('recipe', template.name),
      name: template.name,
      ingredients: allIngredients,
      instructions: template.instructions,
      servings: template.servings,
      timeMinutes: template.timeMinutes,
      missingIngredients: pantryIngredients,
      createdAt: new Date().toISOString(),
    };
  });
}

function mapRawRecipesToRecipes(rawRecipes: z.infer<typeof rawRecipeSchema>[]): Recipe[] {
  return rawRecipes.map((rawRecipe) => {
    const ingredients: RecipeIngredient[] = rawRecipe.ingredients.map((ingredient) => ({
      id: stableId('ingredient', `${rawRecipe.name}_${ingredient.name}`),
      name: ingredient.name,
      normalizedName: normalizeText(ingredient.name),
      amount: ingredient.amount,
      unit: ingredient.unit,
      missing: false,
    }));

    return {
      id: stableId('recipe', rawRecipe.name),
      name: rawRecipe.name,
      ingredients,
      instructions: rawRecipe.instructions,
      servings: rawRecipe.servings,
      timeMinutes: rawRecipe.timeMinutes,
      missingIngredients: [],
      createdAt: new Date().toISOString(),
    };
  });
}

export async function generateRecipesFromOffers(
  offers: Offer[],
  preferences: UserPreferences,
  tryOllama: boolean,
): Promise<{ recipes: Recipe[]; warnings: string[] }> {
  const filteredOffers = offers.filter((offer) =>
    offerMatchesPreferences(offer, preferences),
  );
  const warnings: string[] = [];

  if (filteredOffers.length === 0) {
    return {
      recipes: [],
      warnings: ['Keine passenden Angebote für die gewählten Präferenzen gefunden.'],
    };
  }

  if (tryOllama) {
    try {
      const compactOfferList = filteredOffers.slice(0, 32).map((offer) => ({
        name: offer.name,
        category: offer.category,
        price: offer.price,
        tags: offer.tags,
      }));

      const prompt = `
Erstelle 3 alltagstaugliche Rezepte anhand dieser Angebotsdaten und Präferenzen.
Gib nur valides JSON zurück.
Schema:
{
  "recipes": [
    {
      "name": "string",
      "servings": 2,
      "timeMinutes": 30,
      "instructions": ["string"],
      "ingredients": [
        {
          "name": "string",
          "amount": 1,
          "unit": "string"
        }
      ]
    }
  ]
}

Präferenzen:
- vegetarisch: ${preferences.vegetarian}
- vegan: ${preferences.vegan}
- halal: ${preferences.halal}
- allergien: ${preferences.allergies.join(', ') || 'keine'}
- no-go: ${preferences.noGoIngredients.join(', ') || 'keine'}

Angebote:
${JSON.stringify(compactOfferList)}
      `.trim();

      const response = await ollamaChat(
        [
          {
            role: 'system',
            content:
              'Du bist AIChef. Gib ausschließlich valides JSON gemäß Schema zurück.',
          },
          { role: 'user', content: prompt },
        ],
        {
          model: appConfig.ollamaModel,
          timeoutMs: appConfig.ollamaTimeoutMs,
          retries: 1,
          temperature: 0.3,
        },
      );

      const parsedRecipes = parseOllamaRecipeResponse(response);
      if (parsedRecipes.length > 0) {
        const recipes = mapRawRecipesToRecipes(parsedRecipes).map((recipe) =>
          mapMissingIngredients(recipe, filteredOffers),
        );

        return {
          recipes,
          warnings,
        };
      }
      warnings.push('LLM-Antwort war nicht im erwarteten JSON-Format. Fallback aktiv.');
    } catch (error) {
      warnings.push(
        `Ollama nicht verfügbar: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}. Fallback aktiv.`,
      );
    }
  }

  const fallbackRecipes = buildFallbackRecipes(filteredOffers).map((recipe) =>
    mapMissingIngredients(recipe, filteredOffers),
  );

  return {
    recipes: fallbackRecipes,
    warnings,
  };
}

export function recipeIngredientsToShoppingItems(recipe: Recipe): ShoppingListItem[] {
  return recipe.ingredients.map((ingredient) => ({
    id: stableId('shopping', `${recipe.id}_${ingredient.name}`),
    name: ingredient.name,
    normalizedName: ingredient.normalizedName,
    quantity: ingredient.amount,
    unit: ingredient.unit,
    note: ingredient.missing ? 'Fehlt im Angebot' : '',
    checked: false,
    createdAt: new Date().toISOString(),
  }));
}
