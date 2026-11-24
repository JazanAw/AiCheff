import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CATEGORIES, CATEGORY_LABELS,
  DIFFICULTIES, DIFFICULTY_LABELS,
  MEAL_TYPES, MEAL_TYPE_LABELS,
  SOURCE_TYPE_LABELS, VERIFICATION_STATUS_LABELS,
  deleteRecipe, listRecipes, recipeReviewFlags, setRecipeStatus,
  type DealCategory, type Difficulty, type MealType,
  type RecipeListRow, type RecipeStatus,
} from '../lib/recipes';

// Client-side quick filters over the already-loaded rows. They surface the
// review/quality gaps an admin cares about without extra round-trips.
type QuickFilter =
  | 'all' | 'ai' | 'human' | 'review'
  | 'no_image' | 'no_nutrition' | 'no_cuisine';

const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'ai', label: 'KI-Entwurf' },
  { id: 'human', label: 'Mensch verifiziert' },
  { id: 'review', label: 'Review nötig' },
  { id: 'no_image', label: 'Ohne Bild' },
  { id: 'no_nutrition', label: 'Ohne Nutrition' },
  { id: 'no_cuisine', label: 'Ohne Kategorie' },
];

function matchesQuickFilter(row: RecipeListRow, filter: QuickFilter): boolean {
  if (filter === 'all') return true;
  const f = recipeReviewFlags(row);
  switch (filter) {
    case 'ai': return f.isAi;
    case 'human': return row.source_type === 'human_verified';
    case 'review': return f.needsReview || f.missingAiNotice;
    case 'no_image': return f.missingImage;
    case 'no_nutrition': return f.missingNutrition;
    case 'no_cuisine': return f.missingCuisine;
    default: return true;
  }
}

export function RecipeListPage() {
  const [rows, setRows] = useState<RecipeListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterMeal, setFilterMeal] = useState<MealType | ''>('');
  const [filterCategory, setFilterCategory] = useState<DealCategory | ''>('');
  const [filterDifficulty, setFilterDifficulty] = useState<Difficulty | ''>('');
  const [filterStatus, setFilterStatus] = useState<RecipeStatus | ''>('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRecipes({
        search: search || undefined,
        mealType: filterMeal || undefined,
        category: filterCategory || undefined,
        difficulty: filterDifficulty || undefined,
        status: filterStatus || undefined,
      });
      setRows(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // One-time load on mount; reload() sets its own loading/error state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const quickCounts = useMemo(() => {
    const counts = {} as Record<QuickFilter, number>;
    for (const { id } of QUICK_FILTERS) {
      counts[id] = rows.filter((r) => matchesQuickFilter(r, id)).length;
    }
    return counts;
  }, [rows]);

  const visible = useMemo(
    () => rows.filter((r) => matchesQuickFilter(r, quickFilter)),
    [rows, quickFilter],
  );

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold mb-1">Rezepte</h1>
          <p className="text-slate-600">{loading ? 'Lädt…' : `${visible.length} Rezept${visible.length === 1 ? '' : 'e'}`}</p>
        </div>
        <Link
          to="/recipes/new"
          className="bg-primary hover:bg-primary-dark text-white font-medium px-4 py-2 rounded-md text-sm"
        >
          + Neues Rezept
        </Link>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 grid grid-cols-1 md:grid-cols-5 gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') reload(); }}
          placeholder="Suche (deutscher Name)…"
          className="px-3 py-2 border border-slate-300 rounded-md text-sm md:col-span-2 focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <FilterSelect
          value={filterMeal}
          onChange={(v) => setFilterMeal(v as MealType | '')}
          placeholder="Alle Mahlzeiten"
          options={MEAL_TYPES.map((m) => ({ value: m, label: MEAL_TYPE_LABELS[m] }))}
        />
        <FilterSelect
          value={filterCategory}
          onChange={(v) => setFilterCategory(v as DealCategory | '')}
          placeholder="Alle Kategorien"
          options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
        />
        <FilterSelect
          value={filterDifficulty}
          onChange={(v) => setFilterDifficulty(v as Difficulty | '')}
          placeholder="Alle Schwierigkeiten"
          options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABELS[d] }))}
        />
        <div className="md:col-span-5 flex items-center gap-2">
          <FilterSelect
            value={filterStatus}
            onChange={(v) => setFilterStatus(v as RecipeStatus | '')}
            placeholder="Alle Status"
            options={[
              { value: 'active', label: 'Aktiv' },
              { value: 'hidden', label: 'Versteckt' },
            ]}
          />
          <button
            onClick={reload}
            className="px-3 py-2 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-dark"
          >
            Anwenden
          </button>
          {(search || filterMeal || filterCategory || filterDifficulty || filterStatus) && (
            <button
              onClick={() => {
                setSearch(''); setFilterMeal(''); setFilterCategory('');
                setFilterDifficulty(''); setFilterStatus('');
                setTimeout(reload, 0);
              }}
              className="px-3 py-2 text-slate-600 hover:text-slate-900 text-sm"
            >
              Zurücksetzen
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {QUICK_FILTERS.map((qf) => {
          const active = quickFilter === qf.id;
          const danger = qf.id === 'review';
          return (
            <button
              key={qf.id}
              onClick={() => setQuickFilter(qf.id)}
              className={
                'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ' +
                (active
                  ? danger
                    ? 'bg-amber-500 border-amber-500 text-white'
                    : 'bg-primary border-primary text-white'
                  : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50')
              }
            >
              {qf.label}
              <span className={'ml-1.5 ' + (active ? 'opacity-80' : 'text-slate-400')}>
                {quickCounts[qf.id] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 mb-4 text-sm">
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-slate-600">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Mahlzeit</th>
              <th className="px-4 py-3 font-medium">Kategorie</th>
              <th className="px-4 py-3 font-medium">Schwierigkeit</th>
              <th className="px-4 py-3 font-medium text-right">Zeit</th>
              <th className="px-4 py-3 font-medium text-right">Bewertung</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">Aktionen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-slate-500">
                  Keine Rezepte. <Link to="/recipes/new" className="text-primary underline">Erstes anlegen</Link>
                </td>
              </tr>
            )}
            {visible.map((row) => (
              <RecipeRow key={row.id} row={row} onChanged={reload} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterSelect({
  value, onChange, placeholder, options,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-2 border border-slate-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

type BadgeTone = 'ai' | 'human' | 'public' | 'review' | 'warn';
const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  ai: 'bg-violet-50 text-violet-700 border-violet-200',
  human: 'bg-green-50 text-green-700 border-green-200',
  public: 'bg-sky-50 text-sky-700 border-sky-200',
  review: 'bg-amber-100 text-amber-800 border-amber-300',
  warn: 'bg-slate-100 text-slate-500 border-slate-200',
};

function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  const cls = BADGE_TONE_CLASSES;
  return (
    <span className={'px-1.5 py-0.5 rounded text-[10px] font-medium border ' + cls[tone]}>
      {label}
    </span>
  );
}

/** Source + review + missing-data badges shown under the recipe name. */
function RecipeBadges({ row }: { row: RecipeListRow }) {
  const flags = recipeReviewFlags(row);
  const sourceType = row.source_type ?? 'human_verified';
  const sourceTone: 'ai' | 'human' | 'public' =
    flags.isAi ? 'ai' : sourceType === 'public_domain_adapted' ? 'public' : 'human';

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      <Badge label={SOURCE_TYPE_LABELS[sourceType]} tone={sourceTone} />
      {row.verification_status && row.verification_status !== 'published' && (
        <Badge label={VERIFICATION_STATUS_LABELS[row.verification_status]} tone="review" />
      )}
      {flags.needsReview && <Badge label="Review nötig" tone="review" />}
      {flags.missingAiNotice && <Badge label="KI-Hinweis fehlt" tone="review" />}
      {flags.missingImage && <Badge label="Ohne Bild" tone="warn" />}
      {flags.missingNutrition && <Badge label="Ohne Nutrition" tone="warn" />}
      {flags.missingCuisine && <Badge label="Ohne Kategorie" tone="warn" />}
    </div>
  );
}

function RecipeRow({ row, onChanged }: { row: RecipeListRow; onChanged: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const toggleHidden = async () => {
    setBusy(true);
    try {
      await setRecipeStatus(row.id, row.status === 'active' ? 'hidden' : 'active');
      onChanged();
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    const name = row.name?.de ?? 'Rezept';
    if (!window.confirm(`"${name}" endgültig löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return;
    setBusy(true);
    try {
      await deleteRecipe(row.id);
      onChanged();
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="hover:bg-slate-50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {row.image_url ? (
            <img src={row.image_url} alt="" className="w-10 h-10 rounded-md object-cover" />
          ) : (
            <div className="w-10 h-10 rounded-md bg-slate-100 flex items-center justify-center text-slate-400 text-xs">—</div>
          )}
          <div>
            <div className="font-medium text-slate-900">{row.name?.de ?? '(ohne Name)'}</div>
            <div className="text-xs text-slate-400 font-mono">{row.id.slice(0, 8)}</div>
            <RecipeBadges row={row} />
          </div>
        </div>
      </td>
      <td className="px-4 py-3">{MEAL_TYPE_LABELS[row.meal_type]}</td>
      <td className="px-4 py-3">{CATEGORY_LABELS[row.category]}</td>
      <td className="px-4 py-3">{DIFFICULTY_LABELS[row.difficulty]}</td>
      <td className="px-4 py-3 text-right tabular-nums">{row.cook_time_minutes} min</td>
      <td className="px-4 py-3 text-right tabular-nums">
        {row.rating != null ? (
          <span>{row.rating.toFixed(1)} <span className="text-slate-400">({row.rating_count})</span></span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span
          className={
            'px-2 py-0.5 rounded-full text-xs font-medium ' +
            (row.status === 'active'
              ? 'bg-green-50 text-green-700'
              : 'bg-slate-100 text-slate-500')
          }
        >
          {row.status === 'active' ? 'Aktiv' : 'Versteckt'}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex justify-end gap-3 text-sm">
          <button
            onClick={() => navigate(`/recipes/${row.id}`)}
            disabled={busy}
            className="text-primary hover:text-primary-dark font-medium"
          >
            Bearbeiten
          </button>
          <button
            onClick={toggleHidden}
            disabled={busy}
            className="text-slate-600 hover:text-slate-900"
          >
            {row.status === 'active' ? 'Verstecken' : 'Aktivieren'}
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="text-red-600 hover:text-red-700"
          >
            Löschen
          </button>
        </div>
      </td>
    </tr>
  );
}
