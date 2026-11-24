import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, isAdmin, isLoading, signOut } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500">Lädt...</div>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-6">
        <div className="text-center max-w-md bg-white p-8 rounded-lg border border-slate-200">
          <h1 className="text-2xl font-bold mb-2">Kein Admin-Zugriff</h1>
          <p className="text-slate-600 mb-6">
            Dein Konto ist nicht in der Admin-Liste eingetragen. Wende dich an einen Eigentümer.
          </p>
          <button
            onClick={signOut}
            className="text-primary hover:text-primary-dark underline"
          >
            Abmelden
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
