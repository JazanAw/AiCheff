// Deletes the calling user's account end-to-end.
//
// Auth: requires a valid user JWT (Supabase auto-attaches when called via
// supabase.auth.functions.invoke from a logged-in client). The user can ONLY
// delete their own account — we read the id from the JWT, never from the
// request body.
//
// Cascade: all public.* tables FK to auth.users(id) on delete cascade, so a
// single auth.admin.deleteUser() call wipes profiles, user_preferences,
// subscriptions, user_push_tokens, recipe_swipes, recipe_comments,
// weekly_plan_entries, shopping_list_items, user_body_data,
// user_progress_entries, and any admins row.
//
// Storage: user-scoped buckets (comment-photos, user-avatars) keep files
// under `<userId>/...` — we list and remove those before deleting the user.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const USER_SCOPED_BUCKETS = ['comment-photos', 'user-avatars'] as const;

interface JsonResponseInit {
  status?: number;
}

function jsonResponse(body: unknown, init: JsonResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

async function purgeBucket(
  admin: ReturnType<typeof createClient>,
  bucket: string,
  userId: string,
): Promise<{ removed: number; warning?: string }> {
  try {
    const { data: files, error: listError } = await admin.storage
      .from(bucket)
      .list(userId, { limit: 1000 });
    if (listError) {
      return { removed: 0, warning: `list ${bucket}: ${listError.message}` };
    }
    if (!files || files.length === 0) {
      return { removed: 0 };
    }
    const paths = files.map((file) => `${userId}/${file.name}`);
    const { error: removeError } = await admin.storage.from(bucket).remove(paths);
    if (removeError) {
      return { removed: 0, warning: `remove ${bucket}: ${removeError.message}` };
    }
    return { removed: paths.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { removed: 0, warning: `purge ${bucket} threw: ${message}` };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return jsonResponse({ ok: true });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: 'server_misconfigured' }, { status: 500 });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return jsonResponse({ error: 'unauthorized' }, { status: 401 });
  }

  // 1) Verify the caller's JWT using the anon client + auth header.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: getUserError } = await userClient.auth.getUser();
  if (getUserError || !userData?.user) {
    return jsonResponse({ error: 'invalid_token', detail: getUserError?.message }, { status: 401 });
  }
  const userId = userData.user.id;
  const userEmail = userData.user.email ?? null;

  // 2) Use service-role client for cleanup that needs elevated privileges.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 3) Purge user-scoped storage. Best-effort: warn on failure but continue.
  const warnings: string[] = [];
  const storageResults: Record<string, number> = {};
  for (const bucket of USER_SCOPED_BUCKETS) {
    const result = await purgeBucket(admin, bucket, userId);
    storageResults[bucket] = result.removed;
    if (result.warning) warnings.push(result.warning);
  }

  // 4) Delete the auth user. FK cascades wipe all public.* rows.
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    return jsonResponse(
      {
        error: 'delete_failed',
        detail: deleteError.message,
        storage: storageResults,
        warnings,
      },
      { status: 500 },
    );
  }

  return jsonResponse({
    ok: true,
    deleted_user_id: userId,
    deleted_email: userEmail,
    storage: storageResults,
    warnings,
  });
});
