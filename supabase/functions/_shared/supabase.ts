// Shared Supabase client helpers for the Stripe Edge Functions.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

/** Reads a required env var or throws — keeps "misconfigured" failures loud. */
export function getEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`missing_env:${name}`);
  }
  return value;
}

/** Optional env var (no throw). */
export function getOptionalEnv(name: string): string | null {
  return Deno.env.get(name) ?? null;
}

/**
 * Service-role client. Bypasses RLS — used by the webhook to write
 * public.subscriptions / public.stripe_events. Never expose this to a client.
 */
export function getAdminClient(): SupabaseClient {
  return createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface AuthedUser {
  id: string;
  email: string | null;
}

/**
 * Verifies the caller's JWT (from the Authorization header) and returns the
 * user. Returns null when the header is missing or the token is invalid —
 * callers should respond 401 in that case. The user id is taken from the
 * verified token, never from the request body.
 */
export async function getUserFromRequest(req: Request): Promise<AuthedUser | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return null;
  }
  const userClient = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) {
    return null;
  }
  return { id: data.user.id, email: data.user.email ?? null };
}

export type { SupabaseClient };
