-- Adds the `documents` table the Documents tab (chantiers.$id.index.tsx)
-- has been waiting on ("L'historique des PDF nécessite la migration
-- 'documents'") and the `bordereaux` storage bucket the new bordereau PDF
-- generator (src/lib/server/bordereauPdf.tsx +
-- generateBordereauPdfServerFn in chantiers.$id.recap.$marcheId.tsx)
-- uploads generated PDFs into.
--
-- One row per generated PDF version -- rows are never overwritten, so the
-- Documents tab can list the full version history for a marché.

CREATE TABLE IF NOT EXISTS public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chantier_id UUID NOT NULL,
  marche_id UUID,
  version INTEGER NOT NULL,
  fichier_url TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT fk_documents_chantier FOREIGN KEY (chantier_id) REFERENCES public.chantiers(id) ON DELETE CASCADE,
  CONSTRAINT fk_documents_marche FOREIGN KEY (marche_id) REFERENCES public.marches(id) ON DELETE CASCADE,
  CONSTRAINT fk_documents_created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT unique_document_version_per_marche UNIQUE (marche_id, version)
);
COMMENT ON TABLE public.documents IS 'Generated bordereau PDFs, one row per version. Never overwritten.';
COMMENT ON COLUMN public.documents.version IS 'Sequential version number, starting at 1, per marche_id';
COMMENT ON COLUMN public.documents.fichier_url IS 'Public URL of the generated PDF in the bordereaux storage bucket';
COMMENT ON COLUMN public.documents.storage_path IS 'Object path within the bordereaux bucket (for cleanup/removal)';

CREATE INDEX IF NOT EXISTS idx_documents_chantier_id ON public.documents(chantier_id);
CREATE INDEX IF NOT EXISTS idx_documents_marche_id ON public.documents(marche_id);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- Same "any authenticated team member" scoping as marches/marche_lignes/
-- bid_lignes (202608110000001_marche_remplir.sql) -- generating and
-- viewing bordereau PDFs isn't admin-only.
CREATE POLICY "documents_read_all" ON public.documents
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "documents_write" ON public.documents
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ----------------------------------------------------------------------
-- Storage bucket for generated PDFs. Public bucket + public read policy,
-- mirroring the catalogue-images bucket
-- (202608101200000_create_catalogue_images_bucket.sql) -- the PDF is
-- generated server-side with the service role key, so only the read
-- policy actually matters for normal app traffic; the insert policy
-- below is a defensive fallback in case a non-service-role client ever
-- needs to upload here directly.
-- ----------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('bordereaux', 'bordereaux', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "bordereaux_upload"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'bordereaux');

CREATE POLICY "bordereaux_read"
ON storage.objects
FOR SELECT
USING (bucket_id = 'bordereaux');

-- Sanity check after applying: generating a bordereau PDF from the recap
-- page should insert a documents row and a storage object, and the
-- Documents tab should list it instead of showing "migration requise".