-- Adds the missing image_url column on materiel_catalogue.
--
-- The catalogue item form already uploads product photos to the
-- "catalogue-images" storage bucket (see
-- 202608101200000_create_catalogue_images_bucket.sql) and tries to persist
-- the returned public URL on materiel_catalogue.image_url, but no
-- migration ever added that column -- it only exists on the frontend
-- CatalogueItem type. That's the "image_url not found" error on
-- create/edit. This migration adds the column; no backfill needed since
-- no row could have had a value for it before now.

ALTER TABLE public.materiel_catalogue ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN public.materiel_catalogue.image_url IS
  'Public URL of the product photo in the catalogue-images storage bucket (nullable)';