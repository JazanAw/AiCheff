import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MultilingualField } from '../components/MultilingualField';
import {
  ALLERGEN_LABELS, ALLERGENS, CATEGORIES, CATEGORY_LABELS,
  DIFFICULTIES, DIFFICULTY_LABELS, MEAL_TYPES, MEAL_TYPE_LABELS,
  SOURCE_TYPES, SOURCE_TYPE_LABELS,
  VERIFICATION_STATUSES, VERIFICATION_STATUS_LABELS,
  getRecipe, saveRecipe, uploadRecipeImage,
  type Allergen, type DealCategory, type Difficulty, type IngredientDraft,
  type InstructionDraft, type MealType, type MultiLangText, type RecipeStatus,
  type RecipeSourceType, type RecipeVerificationStatus,
} from '../lib/recipes';

interface Draft {
  name: MultiLangText;
  intro: MultiLangText;
  meal_type: MealType;
  category: DealCategory;
  difficulty: Difficulty;
  cook_time_minutes: number;
  default_portions: number;
  status: RecipeStatus;
  image_url: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  ingredients: IngredientDraft[];
  instructions: InstructionDraft[];
  source_type: RecipeSourceType;
  verification_status: RecipeVerificationStatus;
  source_title: string;
  source_author: string;
  source_year: number | null;
  source_url: string;
  source_license: string;
  ai_notice_required: boolean;
  safety_notes: string;
}

const emptyDraft = (): Draft => ({
  name: { de: '' },
  intro: {},
  meal_type: 'lunch',
  category: 'other',
  difficulty: 'medium',
  cook_time_minutes: 30,
  default_portions: 2,
  status: 'active',
  image_url: null,
  calories: null,
  protein_g: null,
  carbs_g: null,
  fat_g: null,
  ingredients: [],
  instructions: [],
  source_type: 'human_verified',
  verification_status: 'published',
  source_title: '',
  source_author: '',
  source_year: null,
  source_url: '',
  source_license: '',
  ai_notice_required: false,
  safety_notes: '',
});

const newIngredient = (): IngredientDraft => ({
  name_de: '', amount: 1, unit: 'g',
  is_potential_deal: true, allergens: [],
  is_halal: true, contains_alcohol: false,
});

const newInstruction = (): InstructionDraft => ({ text_de: '' });

export function RecipeEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !id;

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await getRecipe(id!);
        if (cancelled) return;
        if (!r) {
          setError('Rezept nicht gefunden');
          return;
        }
        setDraft({
          name: r.name ?? { de: '' },
          intro: r.intro ?? {},
          meal_type: r.meal_type,
          category: r.category,
          difficulty: r.difficulty,
          cook_time_minutes: r.cook_time_minutes,
          default_portions: r.default_portions,
          status: r.status,
          image_url: r.image_url,
          calories: r.calories,
          protein_g: r.protein_g,
          carbs_g: r.carbs_g,
          fat_g: r.fat_g,
          ingredients: r.ingredients,
          instructions: r.instructions,
          source_type: r.source_type,
          verification_status: r.verification_status,
          source_title: r.source_title ?? '',
          source_author: r.source_author ?? '',
          source_year: r.source_year,
          source_url: r.source_url ?? '',
          source_license: r.source_license ?? '',
          ai_notice_required: r.ai_notice_required,
          safety_notes: r.safety_notes ?? '',
        });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, isNew]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const validate = (): string | null => {
    if (!draft.name.de?.trim()) return 'Deutscher Rezeptname ist Pflicht.';
    if (draft.cook_time_minutes < 1 || draft.cook_time_minutes > 600) return 'Kochzeit zwischen 1 und 600 Minuten.';
    if (draft.default_portions < 1 || draft.default_portions > 12) return 'Portionen zwischen 1 und 12.';
    for (const ing of draft.ingredients) {
      if (!ing.name_de.trim()) return 'Jede Zutat braucht einen Namen.';
      if (ing.amount < 0) return 'Zutaten-Menge darf nicht negativ sein.';
    }
    for (const ins of draft.instructions) {
      if (!ins.text_de.trim()) return 'Jeder Anleitungs-Schritt braucht Text.';
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setError(null);
    setSaving(true);
    try {
      const savedId = await saveRecipe({
        id,
        name: draft.name,
        intro: draft.intro,
        meal_type: draft.meal_type,
        category: draft.category,
        difficulty: draft.difficulty,
        cook_time_minutes: draft.cook_time_minutes,
        default_portions: draft.default_portions,
        status: draft.status,
        image_url: draft.image_url,
        calories: draft.calories,
        protein_g: draft.protein_g,
        carbs_g: draft.carbs_g,
        fat_g: draft.fat_g,
        ingredients: draft.ingredients,
        instructions: draft.instructions,
        source_type: draft.source_type,
        verification_status: draft.verification_status,
        source_title: draft.source_title || null,
        source_author: draft.source_author || null,
        source_year: draft.source_year,
        source_url: draft.source_url || null,
        source_license: draft.source_license || null,
        ai_notice_required: draft.ai_notice_required,
        safety_notes: draft.safety_notes || null,
      });
      navigate(`/recipes/${savedId}`, { replace: true });
      window.alert('Rezept gespeichert.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleImageFile = async (file: File) => {
    if (!file) return;
    setUploadingImage(true);
    setError(null);
    try {
      // For new recipes that haven't been saved yet, generate a temp id
      const targetId = id ?? crypto.randomUUID();
      const url = await uploadRecipeImage(targetId, file);
      update('image_url', url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadingImage(false);
    }
  };

  if (loading) {
    return <div className="text-slate-500">Lädt…</div>;
  }

  return (
    <div className="max-w-4xl mx-auto pb-16">
      <div className="flex items-center justify-between mb-6">
        <div>
          <button onClick={() => navigate('/recipes')} className="text-primary hover:text-primary-dark text-sm font-medium mb-2">
            ← Zurück zur Liste
          </button>
          <h1 className="text-3xl font-bold">
            {isNew ? 'Neues Rezept' : draft.name.de || 'Rezept bearbeiten'}
          </h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => navigate('/recipes')}
            className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-md text-sm font-medium"
          >
            Abbrechen
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-md text-sm font-medium disabled:opacity-60"
          >
            {saving ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 mb-4 text-sm">
          {error}
        </div>
      )}

      {/* Basis */}
      <Section title="Basis">
        <MultilingualField
          label="Rezeptname"
          required
          value={draft.name}
          onChange={(v) => update('name', v)}
          placeholder="z.B. Spaghetti Carbonara"
        />
        <MultilingualField
          label="Intro-Text"
          value={draft.intro}
          onChange={(v) => update('intro', v)}
          placeholder="Kurzer Beschreibungstext für den Rezept-Header (optional)"
          multiline
        />

        <ImagePicker
          imageUrl={draft.image_url}
          uploading={uploadingImage}
          onFile={handleImageFile}
          onClear={() => update('image_url', null)}
        />

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Select
            label="Mahlzeit"
            value={draft.meal_type}
            onChange={(v) => update('meal_type', v as MealType)}
            options={MEAL_TYPES.map((m) => ({ value: m, label: MEAL_TYPE_LABELS[m] }))}
          />
          <Select
            label="Kategorie"
            value={draft.category}
            onChange={(v) => update('category', v as DealCategory)}
            options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          />
          <Select
            label="Schwierigkeit"
            value={draft.difficulty}
            onChange={(v) => update('difficulty', v as Difficulty)}
            options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABELS[d] }))}
          />
          <NumField
            label="Kochzeit (Min.)"
            value={draft.cook_time_minutes}
            // NumField ohne allowNull liefert immer eine Zahl; das ?? deckt nur
            // den (hier unmöglichen) null-Fall des breiteren Prop-Typs ab.
            onChange={(v) => update('cook_time_minutes', v ?? 1)}
            min={1}
            max={600}
          />
          <NumField
            label="Standard-Portionen"
            value={draft.default_portions}
            onChange={(v) => update('default_portions', v ?? 1)}
            min={1}
            max={12}
          />
          <Select
            label="Status"
            value={draft.status}
            onChange={(v) => update('status', v as RecipeStatus)}
            options={[
              { value: 'active', label: 'Aktiv' },
              { value: 'hidden', label: 'Versteckt' },
            ]}
          />
        </div>
      </Section>

      {/* Nutrition */}
      <Section title="Nährwerte pro Portion (optional)">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <NumField
            label="kcal"
            value={draft.calories ?? null}
            onChange={(v) => update('calories', v)}
            allowNull
          />
          <NumField
            label="Protein (g)"
            value={draft.protein_g ?? null}
            onChange={(v) => update('protein_g', v)}
            allowNull
            decimals
          />
          <NumField
            label="Kohlenhydrate (g)"
            value={draft.carbs_g ?? null}
            onChange={(v) => update('carbs_g', v)}
            allowNull
            decimals
          />
          <NumField
            label="Fett (g)"
            value={draft.fat_g ?? null}
            onChange={(v) => update('fat_g', v)}
            allowNull
            decimals
          />
        </div>
      </Section>

      {/* Quelle & Review — provenance + verification metadata.
          Used by the mobile app to surface "Geprüft", "KI-Vorschlag",
          "Gemeinfreie Quelle" badges, and the AI safety notice. */}
      <Section title="Quelle & Review">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Select
            label="Source Type"
            value={draft.source_type}
            onChange={(v) => update('source_type', v as RecipeSourceType)}
            options={SOURCE_TYPES.map((s) => ({
              value: s,
              label: SOURCE_TYPE_LABELS[s],
            }))}
          />
          <Select
            label="Verification Status"
            value={draft.verification_status}
            onChange={(v) =>
              update('verification_status', v as RecipeVerificationStatus)
            }
            options={VERIFICATION_STATUSES.map((s) => ({
              value: s,
              label: VERIFICATION_STATUS_LABELS[s],
            }))}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <TextField
            label="Source Title"
            value={draft.source_title}
            onChange={(v) => update('source_title', v)}
            placeholder="z.B. Die süddeutsche Küche"
          />
          <TextField
            label="Source Author"
            value={draft.source_author}
            onChange={(v) => update('source_author', v)}
            placeholder="z.B. Katharina Prato"
          />
          <NumField
            label="Source Year"
            value={draft.source_year}
            onChange={(v) => update('source_year', v)}
            allowNull
            min={1500}
            max={2100}
          />
          <TextField
            label="Source License"
            value={draft.source_license}
            onChange={(v) => update('source_license', v)}
            placeholder="z.B. CC BY-SA 4.0 oder Public Domain"
          />
        </div>

        <TextField
          label="Source URL"
          value={draft.source_url}
          onChange={(v) => update('source_url', v)}
          placeholder="https://…"
        />

        <div className="flex flex-wrap gap-4 text-sm">
          <Toggle
            label="AI Notice Required"
            checked={draft.ai_notice_required}
            onChange={(v) => update('ai_notice_required', v)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Safety Notes
          </label>
          <textarea
            rows={3}
            value={draft.safety_notes}
            onChange={(e) => update('safety_notes', e.target.value)}
            placeholder="Z.B. „Pilze gut durchgaren — Roh-Pilze nicht verträglich.“"
            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </Section>

      {/* Ingredients */}
      <Section
        title="Zutaten"
        action={
          <button
            onClick={() => update('ingredients', [...draft.ingredients, newIngredient()])}
            className="text-primary hover:text-primary-dark text-sm font-medium"
          >
            + Zutat hinzufügen
          </button>
        }
      >
        {draft.ingredients.length === 0 && (
          <p className="text-slate-500 text-sm">Noch keine Zutaten.</p>
        )}
        <div className="space-y-3">
          {draft.ingredients.map((ing, i) => (
            <IngredientRow
              key={i}
              ing={ing}
              onChange={(updated) => {
                const next = [...draft.ingredients];
                next[i] = updated;
                update('ingredients', next);
              }}
              onRemove={() => update('ingredients', draft.ingredients.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      </Section>

      {/* Instructions */}
      <Section
        title="Zubereitung"
        action={
          <button
            onClick={() => update('instructions', [...draft.instructions, newInstruction()])}
            className="text-primary hover:text-primary-dark text-sm font-medium"
          >
            + Schritt hinzufügen
          </button>
        }
      >
        {draft.instructions.length === 0 && (
          <p className="text-slate-500 text-sm">Noch keine Schritte.</p>
        )}
        <div className="space-y-3">
          {draft.instructions.map((step, i) => (
            <InstructionRow
              key={i}
              index={i}
              step={step}
              onChange={(updated) => {
                const next = [...draft.instructions];
                next[i] = updated;
                update('instructions', next);
              }}
              onRemove={() => update('instructions', draft.instructions.filter((_, j) => j !== i))}
              canMoveUp={i > 0}
              canMoveDown={i < draft.instructions.length - 1}
              onMoveUp={() => {
                if (i === 0) return;
                const next = [...draft.instructions];
                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                update('instructions', next);
              }}
              onMoveDown={() => {
                if (i === draft.instructions.length - 1) return;
                const next = [...draft.instructions];
                [next[i], next[i + 1]] = [next[i + 1], next[i]];
                update('instructions', next);
              }}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

// --- Sub-components ---------------------------------------------------------

function Section({
  title, action, children,
}: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-6 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Select({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function TextField({
  label, value, onChange, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}</label>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  );
}

function NumField({
  label, value, onChange, min, max, allowNull, decimals,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  allowNull?: boolean;
  decimals?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}</label>
      <input
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={decimals ? '0.01' : '1'}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '' && allowNull) { onChange(null); return; }
          const n = decimals ? parseFloat(raw) : parseInt(raw, 10);
          onChange(Number.isFinite(n) ? n : (allowNull ? null : 0));
        }}
        className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  );
}

function ImagePicker({
  imageUrl, uploading, onFile, onClear,
}: {
  imageUrl: string | null;
  uploading: boolean;
  onFile: (f: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">Bild</label>
      <div className="flex items-center gap-4">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="w-32 h-32 rounded-lg object-cover border border-slate-200" />
        ) : (
          <div className="w-32 h-32 rounded-lg border-2 border-dashed border-slate-300 flex items-center justify-center text-slate-400 text-sm">
            Kein Bild
          </div>
        )}
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-sm font-medium"
          >
            {uploading ? 'Lädt hoch…' : (imageUrl ? 'Bild ersetzen' : 'Bild hochladen')}
          </button>
          {imageUrl && (
            <button
              type="button"
              onClick={onClear}
              className="px-3 py-1.5 text-red-600 hover:text-red-700 text-sm"
            >
              Entfernen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function IngredientRow({
  ing, onChange, onRemove,
}: {
  ing: IngredientDraft;
  onChange: (next: IngredientDraft) => void;
  onRemove: () => void;
}) {
  const toggleAllergen = (a: Allergen) => {
    const has = ing.allergens.includes(a);
    onChange({
      ...ing,
      allergens: has ? ing.allergens.filter((x) => x !== a) : [...ing.allergens, a],
    });
  };

  return (
    <div className="border border-slate-200 rounded-md p-3 bg-slate-50">
      <div className="grid grid-cols-12 gap-2 items-end">
        <div className="col-span-12 md:col-span-5">
          <label className="block text-xs font-medium text-slate-600 mb-1">Name (DE)</label>
          <input
            type="text"
            value={ing.name_de}
            onChange={(e) => onChange({ ...ing, name_de: e.target.value })}
            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div className="col-span-4 md:col-span-2">
          <label className="block text-xs font-medium text-slate-600 mb-1">Menge</label>
          <input
            type="number"
            value={ing.amount}
            min={0}
            step="0.01"
            onChange={(e) => onChange({ ...ing, amount: parseFloat(e.target.value) || 0 })}
            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div className="col-span-4 md:col-span-2">
          <label className="block text-xs font-medium text-slate-600 mb-1">Einheit</label>
          <input
            type="text"
            value={ing.unit}
            onChange={(e) => onChange({ ...ing, unit: e.target.value })}
            placeholder="g, ml, Stk."
            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div className="col-span-4 md:col-span-3 flex items-end justify-end">
          <button
            onClick={onRemove}
            className="px-2 py-1.5 text-red-600 hover:text-red-700 text-sm"
          >
            Entfernen
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {ALLERGENS.map((a) => {
          const active = ing.allergens.includes(a);
          return (
            <button
              key={a}
              onClick={() => toggleAllergen(a)}
              className={
                'px-2 py-0.5 rounded-full text-xs font-medium transition ' +
                (active
                  ? 'bg-red-100 text-red-700 border border-red-200'
                  : 'bg-white text-slate-500 border border-slate-200 hover:border-slate-400')
              }
            >
              {ALLERGEN_LABELS[a]}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        <Toggle
          label="Halal"
          checked={ing.is_halal}
          onChange={(v) => onChange({ ...ing, is_halal: v })}
        />
        <Toggle
          label="Enthält Alkohol"
          checked={ing.contains_alcohol}
          onChange={(v) => onChange({ ...ing, contains_alcohol: v })}
        />
        <Toggle
          label="Mögliche Deal-Zutat"
          checked={ing.is_potential_deal}
          onChange={(v) => onChange({ ...ing, is_potential_deal: v })}
        />
      </div>
    </div>
  );
}

function InstructionRow({
  index, step, onChange, onRemove, canMoveUp, canMoveDown, onMoveUp, onMoveDown,
}: {
  index: number;
  step: InstructionDraft;
  onChange: (next: InstructionDraft) => void;
  onRemove: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <div className="border border-slate-200 rounded-md p-3 bg-slate-50">
      <div className="flex gap-3 items-start">
        <div className="w-8 h-8 rounded-full bg-primary text-white text-sm font-semibold flex items-center justify-center flex-shrink-0">
          {index + 1}
        </div>
        <div className="flex-1">
          <textarea
            rows={3}
            value={step.text_de}
            onChange={(e) => onChange({ text_de: e.target.value })}
            placeholder="Schritt-Beschreibung (Deutsch)"
            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div className="flex flex-col gap-1">
          <button onClick={onMoveUp} disabled={!canMoveUp} className="text-slate-500 hover:text-slate-900 disabled:opacity-30 px-1">↑</button>
          <button onClick={onMoveDown} disabled={!canMoveDown} className="text-slate-500 hover:text-slate-900 disabled:opacity-30 px-1">↓</button>
          <button onClick={onRemove} className="text-red-600 hover:text-red-700 text-xs px-1">×</button>
        </div>
      </div>
    </div>
  );
}

function Toggle({
  label, checked, onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-slate-300 text-primary focus:ring-primary"
      />
      <span className="text-slate-700">{label}</span>
    </label>
  );
}
