-- Cheffity schema: storage buckets and per-bucket policies.

insert into storage.buckets (id, name, public)
values
  ('recipe-images',     'recipe-images',     true),
  ('comment-photos',    'comment-photos',    true),
  ('user-avatars',      'user-avatars',      true),
  ('cookbook-uploads',  'cookbook-uploads',  false)
on conflict (id) do nothing;

-- recipe-images: public read; admin write.
create policy "recipe-images read"
  on storage.objects for select
  to public
  using (bucket_id = 'recipe-images');

create policy "recipe-images admin insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'recipe-images' and public.is_admin());

create policy "recipe-images admin update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'recipe-images' and public.is_admin())
  with check (bucket_id = 'recipe-images' and public.is_admin());

create policy "recipe-images admin delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'recipe-images' and public.is_admin());

-- comment-photos: public read; user can write under their own folder (uid prefix).
create policy "comment-photos read"
  on storage.objects for select
  to public
  using (bucket_id = 'comment-photos');

create policy "comment-photos owner insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'comment-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "comment-photos owner delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'comment-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- user-avatars: public read; user can write under their own uid prefix.
create policy "user-avatars read"
  on storage.objects for select
  to public
  using (bucket_id = 'user-avatars');

create policy "user-avatars owner write"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "user-avatars owner update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "user-avatars owner delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'user-avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- cookbook-uploads: admin only, private.
create policy "cookbook-uploads admin all"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'cookbook-uploads' and public.is_admin())
  with check (bucket_id = 'cookbook-uploads' and public.is_admin());
