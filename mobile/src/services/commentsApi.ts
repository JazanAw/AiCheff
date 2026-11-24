import { supabase } from '../config/supabase';
import type { RecipeComment } from '../types';

interface SupabaseCommentRow {
  id: string;
  recipe_id: string;
  user_id: string;
  rating: number;
  text: string;
  photo_url: string | null;
  author_name: string | null;
  created_at: string;
}

function deriveInitials(input: string | null | undefined): string {
  if (!input) return '?';
  const cleaned = input.trim();
  if (!cleaned) return '?';
  const localPart = cleaned.includes('@') ? cleaned.split('@')[0] : cleaned;
  const tokens = localPart.split(/[\s._-]+/).filter(Boolean);
  if (tokens.length === 0) return localPart.slice(0, 2).toUpperCase();
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return (tokens[0][0] + tokens[tokens.length - 1][0]).toUpperCase();
}

function deriveUsername(row: SupabaseCommentRow): string {
  const name = row.author_name?.trim();
  if (name) {
    return name.includes('@') ? name.split('@')[0] : name;
  }
  return 'User';
}

function mapRow(row: SupabaseCommentRow): RecipeComment {
  return {
    id: row.id,
    recipeId: row.recipe_id,
    userId: row.user_id,
    username: deriveUsername(row),
    avatarInitials: deriveInitials(row.author_name ?? 'User'),
    rating: Number(row.rating),
    text: row.text,
    photoUrl: row.photo_url ?? undefined,
    createdAt: row.created_at,
  };
}

export async function fetchCommentsForRecipe(recipeId: string): Promise<RecipeComment[]> {
  const { data, error } = await supabase
    .from('recipe_comments')
    .select('id, recipe_id, user_id, rating, text, photo_url, author_name, created_at')
    .eq('recipe_id', recipeId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as SupabaseCommentRow[]).map(mapRow);
}

interface SubmitCommentParams {
  recipeId: string;
  rating: number;  // 0.5 to 5 in 0.5 steps
  text: string;
  photoUrl?: string;
}

export async function submitComment(params: SubmitCommentParams): Promise<RecipeComment> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Nicht angemeldet');

  let authorName: string | null = null;
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('display_name, email')
    .eq('id', user.id)
    .maybeSingle();
  if (!profileError && profile) {
    const p = profile as { display_name?: string | null; email?: string | null };
    authorName = (p.display_name ?? '').trim() || (p.email ?? '').trim() || null;
  }
  if (!authorName) {
    authorName = user.email ?? null;
  }

  const insertPayload = {
    recipe_id: params.recipeId,
    user_id: user.id,
    rating: params.rating,
    text: params.text.trim(),
    photo_url: params.photoUrl ?? null,
    author_name: authorName,
  };

  const { data, error } = await supabase
    .from('recipe_comments')
    .insert(insertPayload)
    .select('id, recipe_id, user_id, rating, text, photo_url, author_name, created_at')
    .single();
  if (error) throw error;
  return mapRow(data as SupabaseCommentRow);
}

export async function deleteComment(commentId: string): Promise<void> {
  const { error } = await supabase
    .from('recipe_comments')
    .delete()
    .eq('id', commentId);
  if (error) throw error;
}
