-- Fixes: "XLSX généré mais échec de l'enregistrement : duplicate key value
-- violates unique constraint 'unique_document_version_per_marche'".
--
-- documents currently has UNIQUE (marche_id, version) -- see
-- 202608117000000_add_documents_and_bordereaux_bucket.sql. That constraint
-- was written when a "document" only ever meant a PDF (one row per
-- version). generateMutation in chantiers.$id.recap.$marcheId.tsx now
-- generates BOTH a PDF and an XLSX per click and deliberately gives them
-- the SAME version number (so both files from one click line up) --
-- inserting two rows that only differ by file format still collides on
-- the old (marche_id, version) constraint, because nothing in the row
-- says which format it is.
--
-- Fix: add a `type` column identifying the format, backfill every
-- existing row as 'pdf' (the only format that has ever existed until
-- now), and widen the unique constraint to (marche_id, version, type) so
-- a PDF row and an XLSX row can coexist at the same version.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS type TEXT;

-- Backfill: every row inserted before this migration was a PDF (the XLSX
-- insert didn't exist yet, and even the one time it briefly ran it failed
-- before this migration -- that's the bug being fixed here).
UPDATE public.documents SET type = 'pdf' WHERE type IS NULL;

ALTER TABLE public.documents
  ALTER COLUMN type SET NOT NULL;

ALTER TABLE public.documents
  DROP CONSTRAINT IF EXISTS documents_type_check;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_type_check CHECK (type IN ('pdf', 'xlsx'));

ALTER TABLE public.documents
  DROP CONSTRAINT IF EXISTS unique_document_version_per_marche;

ALTER TABLE public.documents
  ADD CONSTRAINT unique_document_version_per_marche UNIQUE (marche_id, version, type);

COMMENT ON COLUMN public.documents.type IS
  'Which rendering this row is: pdf or xlsx. Combined with (marche_id, version) in the unique constraint so one generation click can insert one row of each format at the same version number.';

-- Sanity check after applying: clicking "Confirmer et générer le PDF"
-- should insert TWO rows for the new version (one type='pdf', one
-- type='xlsx') instead of failing on the second insert. Existing rows
-- should all read type='pdf':
--   select version, type from public.documents order by version;