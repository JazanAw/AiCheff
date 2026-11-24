import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { AppShell } from './components/AppShell';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { RecipeListPage } from './pages/RecipeListPage';
import { RecipeEditorPage } from './pages/RecipeEditorPage';
import { UsersPage } from './pages/UsersPage';
import { DealsPage } from './pages/DealsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ActivityLogPage } from './pages/ActivityLogPage';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard"     element={<DashboardPage />} />
            <Route path="/recipes"       element={<RecipeListPage />} />
            <Route path="/recipes/new"   element={<RecipeEditorPage />} />
            <Route path="/recipes/:id"   element={<RecipeEditorPage />} />
            <Route path="/users"         element={<UsersPage />} />
            <Route path="/deals"         element={<DealsPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/activity"      element={<ActivityLogPage />} />
            <Route path="/settings"      element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
