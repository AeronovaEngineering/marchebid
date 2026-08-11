-- Creates the public "catalogue-images" storage bucket used by the
-- materiel catalogue item form to store uploaded product photos, plus the
-- storage policies required to upload to and read from it.

insert into storage.buckets (id, name, public)
values ('catalogue-images', 'catalogue-images', true)
on conflict (id) do nothing;

-- Allow authenticated users to upload objects into this bucket.
create policy "catalogue_images_upload"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'catalogue-images');

-- Allow anyone to read objects in this bucket (public bucket, public read).
create policy "catalogue_images_read"
on storage.objects
for select
using (bucket_id = 'catalogue-images');