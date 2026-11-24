import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface MostSwipedRow {
  id: string;
  name_de: string | null;
  planned_count: number;
}

interface DashboardStats {
  total_users: number;
  active_plus: number;
  active_premium: number;
  total_recipes: number;
  deals_scanned_week: number;
  most_swiped_this_week: MostSwipedRow[];
}

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: rpcError } = await supabase.rpc('admin_dashboard_stats');
      if (cancelled) return;
      if (rpcError) {
        setError(rpcError.message);
        return;
      }
      setStats(data as DashboardStats);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Dashboard</h1>

      {error && (
        <div className="mb-6 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-4 py-3">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <StatCard label="Nutzer gesamt"            value={stats?.total_users}        loading={!stats} />
        <StatCard label="Aktive Plus"              value={stats?.active_plus}        loading={!stats} />
        <StatCard label="Aktive Premium"           value={stats?.active_premium}     loading={!stats} />
        <StatCard label="Aktive Rezepte"           value={stats?.total_recipes}      loading={!stats} />
        <StatCard label="Angebote (diese Woche)"   value={stats?.deals_scanned_week} loading={!stats} />
      </div>

      <div className="bg-white p-6 rounded-lg border border-slate-200">
        <h2 className="font-semibold text-lg mb-4">Meist geplante Rezepte (letzte 7 Tage)</h2>
        {!stats ? (
          <div className="text-slate-500 text-sm">Lädt...</div>
        ) : stats.most_swiped_this_week.length === 0 ? (
          <div className="text-slate-500 text-sm">Noch keine Daten verfügbar.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {stats.most_swiped_this_week.map((row) => (
              <li key={row.id} className="py-2 flex justify-between items-center">
                <span>{row.name_de ?? '(ohne Name)'}</span>
                <span className="text-slate-500 text-sm tabular-nums">{row.planned_count}×</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
}) {
  return (
    <div className="bg-white p-6 rounded-lg border border-slate-200">
      <div className="text-sm text-slate-500 mb-2">{label}</div>
      <div className="text-3xl font-bold tabular-nums">
        {loading ? '—' : value ?? 0}
      </div>
    </div>
  );
}
