-- Denormalize the comment author's display name onto the row.
-- Reading comments cross-user would otherwise need to join `profiles`, which
-- RLS restricts to the calling user — easier and faster to snapshot the name
-- at write time. Display name reflects the value at comment time; later
-- profile renames don't propagate (typical social pattern).

alter table public.recipe_comments
  add column if not exists author_name text;

-- Backfill any existing rows (none expected yet) from the user's email.
update public.recipe_comments rc
set author_name = u.email
from auth.users u
where rc.user_id = u.id and rc.author_name is null;
