import { Link, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const NAV: { to: string; label: string }[] = [
  { to: '/dashboard',     label: 'Dashboard' },
  { to: '/recipes',       label: 'Rezepte' },
  { to: '/users',         label: 'Nutzer' },
  { to: '/deals',         label: 'Angebote' },
  { to: '/notifications', label: 'Benachrichtigungen' },
  { to: '/activity',      label: 'Aktivitäts-Log' },
  { to: '/settings',      label: 'Einstellungen' },
];

export function AppShell() {
  const { session, signOut } = useAuth();
  const location = useLocation();

  return (
    <div className="min-h-screen flex">
      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-6 flex items-center gap-2">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center text-white font-bold">
            C
          </div>
          <span className="font-bold text-lg">Cheffity</span>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {NAV.map((item) => {
            const active = location.pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={
                  'block px-3 py-2 rounded-md text-sm transition ' +
                  (active
                    ? 'bg-primary text-white font-medium'
                    : 'text-slate-700 hover:bg-slate-100')
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-200">
          <div className="px-3 py-2 text-xs text-slate-500 truncate">
            {session?.user?.email}
          </div>
          <button
            onClick={signOut}
            className="w-full text-left px-3 py-2 rounded-md text-sm text-slate-700 hover:bg-slate-100"
          >
            Abmelden
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
