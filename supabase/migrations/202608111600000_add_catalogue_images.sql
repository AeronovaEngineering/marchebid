-- Adds the missing DELETE policy on storage.objects for the
-- "catalogue-images" bucket.
--
-- 202608101200000_create_catalogue_images_bucket.sql only ever created
-- "catalogue_images_upload" (INSERT) and "catalogue_images_read" (SELECT)
-- -- there was never a DELETE policy. Same class of bug as every other
-- "the app code is right but it's still not happening" issue in this
-- project (marches/bid_lignes writes, profiles updates, profiles admin
-- reads): with RLS enabled on storage.objects and no permissive DELETE
-- policy for this bucket, Postgres denies the delete outright.
--
-- This is exactly why replacing a product's image in the catalogue item
-- form left the old file behind even after the earlier fix: the client
-- code's storage.from("catalogue-images").remove([oldPath]) call was
-- correct and ran at the right time (after the new upload and the DB
-- update both succeeded), but Postgres silently refused the delete, and
-- until now the resulting error only went to console.error -- invisible
-- to anyone testing the UI rather than watching devtools. (catalogue.tsx
-- has also been updated to surface that failure as a toast, so this class
-- of silent failure gets caught even if a future policy gap reintroduces
-- it.)
--
-- Scoped the same way as the existing upload policy: any authenticated
-- user, matching how this bucket already treats uploads (not admin-only).

create policy "catalogue_images_delete"
on storage.objects
for delete
to authenticated
using (bucket_id = 'catalogue-images');

-- Sanity check after applying: as a logged-in user, editing a catalogue
-- item and replacing its image should leave the OLD file gone from the
-- catalogue-images bucket (check via Supabase Studio's Storage browser,
-- or `select name from storage.objects where bucket_id =
-- 'catalogue-images'` as superuser) -- not just the new one added.