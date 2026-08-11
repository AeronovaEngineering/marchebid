-- ============================================================================
-- AeroNova BID Database Schema - Initial Setup
-- ============================================================================
-- This migration creates the complete schema for the bidder application
-- Includes: enums, tables, foreign keys, indexes, and RLS policies
-- ============================================================================

-- ============================================================================
-- 1. CREATE ENUMS
-- ============================================================================

CREATE TYPE app_role AS ENUM ('admin', 'membre');
COMMENT ON TYPE app_role IS 'User roles: admin (full access) or membre (limited access)';

CREATE TYPE chantier_statut AS ENUM ('brouillon', 'en_cours', 'soumis', 'gagne', 'perdu');
COMMENT ON TYPE chantier_statut IS 'Construction site status';

CREATE TYPE ligne_statut AS ENUM ('non_rempli', 'suggere', 'verifie');
COMMENT ON TYPE ligne_statut IS 'Line item pricing status';

CREATE TYPE catalogue_statut AS ENUM ('brouillon', 'verifie');
COMMENT ON TYPE catalogue_statut IS 'Catalogue item status';

-- ============================================================================
-- 2. CREATE TABLES
-- ============================================================================

-- profiles: User profiles linked to auth.users
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  nom TEXT,
  actif BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT fk_profiles_auth_users FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE
);
COMMENT ON TABLE public.profiles IS 'User profile information, linked to Supabase Auth';
COMMENT ON COLUMN public.profiles.id IS 'Links to auth.users(id)';
COMMENT ON COLUMN public.profiles.email IS 'User email from auth.users';
COMMENT ON COLUMN public.profiles.nom IS 'User full name';
COMMENT ON COLUMN public.profiles.actif IS 'Whether the user account is active';

-- user_roles: Role assignments (one-to-one, but kept separate for flexibility)
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  role app_role NOT NULL DEFAULT 'membre',
  CONSTRAINT fk_user_roles_profiles FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE
);
COMMENT ON TABLE public.user_roles IS 'User role assignments (admin or membre)';
COMMENT ON COLUMN public.user_roles.user_id IS 'References profiles(id)';
COMMENT ON COLUMN public.user_roles.role IS 'The assigned role';

-- chantiers: Construction sites
CREATE TABLE IF NOT EXISTS public.chantiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  client TEXT,
  lieu TEXT,
  statut chantier_statut DEFAULT 'brouillon',
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT fk_chantiers_created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL
);
COMMENT ON TABLE public.chantiers IS 'Construction projects/sites to be quoted';
COMMENT ON COLUMN public.chantiers.nom IS 'Project name';
COMMENT ON COLUMN public.chantiers.client IS 'Client name';
COMMENT ON COLUMN public.chantiers.lieu IS 'Project location';
COMMENT ON COLUMN public.chantiers.statut IS 'Project status (brouillon, en_cours, soumis, gagne, perdu)';
COMMENT ON COLUMN public.chantiers.created_by IS 'User who created the project';

-- marches: Construction lots within a chantier
CREATE TABLE IF NOT EXISTS public.marches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chantier_id UUID NOT NULL,
  lot TEXT NOT NULL,
  fichier_original TEXT,
  format_detecte TEXT,
  date_import TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT fk_marches_chantier FOREIGN KEY (chantier_id) REFERENCES public.chantiers(id) ON DELETE CASCADE,
  CONSTRAINT unique_marche_per_chantier UNIQUE(chantier_id, lot)
);
COMMENT ON TABLE public.marches IS 'Construction lots within a chantier (e.g., Fluides, Structure)';
COMMENT ON COLUMN public.marches.lot IS 'Lot name/identifier';
COMMENT ON COLUMN public.marches.fichier_original IS 'Original imported filename';
COMMENT ON COLUMN public.marches.format_detecte IS 'Detected format (xlsx, pdf, etc.)';

-- marche_lignes: Line items to be priced
CREATE TABLE IF NOT EXISTS public.marche_lignes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marche_id UUID NOT NULL,
  numero TEXT,
  designation TEXT NOT NULL,
  quantite NUMERIC(10, 2) DEFAULT 1,
  unite TEXT,
  chapitre_ou_zone TEXT,
  a_pose BOOLEAN DEFAULT true,
  ordre INTEGER DEFAULT 0,
  CONSTRAINT fk_marche_lignes_marche FOREIGN KEY (marche_id) REFERENCES public.marches(id) ON DELETE CASCADE
);
COMMENT ON TABLE public.marche_lignes IS 'Individual line items extracted from marches';
COMMENT ON COLUMN public.marche_lignes.numero IS 'Line item number from source document';
COMMENT ON COLUMN public.marche_lignes.designation IS 'Full product/service description';
COMMENT ON COLUMN public.marche_lignes.quantite IS 'Quantity needed';
COMMENT ON COLUMN public.marche_lignes.unite IS 'Unit of measure (m, u, kg, etc.)';
COMMENT ON COLUMN public.marche_lignes.chapitre_ou_zone IS 'Section/chapter from document';
COMMENT ON COLUMN public.marche_lignes.a_pose IS 'Whether installation/labor is needed';
COMMENT ON COLUMN public.marche_lignes.ordre IS 'Display order in UI';

-- fourniseeur: Suppliers
CREATE TABLE IF NOT EXISTS public.fourniseeur (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL UNIQUE,
  contact TEXT,
  telephone TEXT,
  email TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
COMMENT ON TABLE public.fourniseeur IS 'Supplier/vendor master data';
COMMENT ON COLUMN public.fourniseeur.nom IS 'Supplier name';
COMMENT ON COLUMN public.fourniseeur.contact IS 'Contact person name';
COMMENT ON COLUMN public.fourniseeur.email IS 'Contact email address';
COMMENT ON COLUMN public.fourniseeur.telephone IS 'Contact phone number';
COMMENT ON COLUMN public.fourniseeur.notes IS 'Internal notes about supplier';

-- materiel_catalogue: Main supplier catalogue
CREATE TABLE IF NOT EXISTS public.materiel_catalogue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur_id UUID,
  designation TEXT NOT NULL,
  unite TEXT NOT NULL,
  prix_fourniture NUMERIC(10, 2) DEFAULT 0,
  categorie TEXT,
  sous_categorie TEXT,
  specs JSONB DEFAULT '{}',
  statut catalogue_statut DEFAULT 'brouillon',
  date_maj TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT fk_materiel_catalogue_fournisseur FOREIGN KEY (fournisseur_id) REFERENCES public.fourniseeur(id) ON DELETE CASCADE
);
COMMENT ON TABLE public.materiel_catalogue IS 'Supplier products/services in the main catalogue';
COMMENT ON COLUMN public.materiel_catalogue.designation IS 'Product name/description';
COMMENT ON COLUMN public.materiel_catalogue.unite IS 'Unit of measure (m, u, kg, etc.)';
COMMENT ON COLUMN public.materiel_catalogue.prix_fourniture IS 'Supplier price (HT)';
COMMENT ON COLUMN public.materiel_catalogue.categorie IS 'Primary category (Tuyauterie, Robinets, etc.)';
COMMENT ON COLUMN public.materiel_catalogue.sous_categorie IS 'Secondary category';
COMMENT ON COLUMN public.materiel_catalogue.specs IS 'Technical specifications as JSON';
COMMENT ON COLUMN public.materiel_catalogue.statut IS 'Approval status (brouillon, verifie)';

-- catalogue_staging: Staging area for catalogue imports
CREATE TABLE IF NOT EXISTS public.catalogue_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur_id UUID,
  designation TEXT NOT NULL,
  unite TEXT,
  prix_fourniture NUMERIC(10, 2) DEFAULT 0,
  categorie TEXT,
  sous_categorie TEXT,
  specs JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT fk_catalogue_staging_fournisseur FOREIGN KEY (fournisseur_id) REFERENCES public.fourniseeur(id) ON DELETE CASCADE
);
COMMENT ON TABLE public.catalogue_staging IS 'Review/approval buffer before items enter materiel_catalogue';

-- bid_lignes: 1:1 pricing/matching for marche_lignes
CREATE TABLE IF NOT EXISTS public.bid_lignes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marche_ligne_id UUID NOT NULL UNIQUE,
  materiel_catalogue_id UUID,
  prix_fourniture NUMERIC(10, 2) DEFAULT 0,
  prix_pose NUMERIC(10, 2) DEFAULT 0,
  statut ligne_statut DEFAULT 'non_rempli',
  notes TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT fk_bid_lignes_marche_ligne FOREIGN KEY (marche_ligne_id) REFERENCES public.marche_lignes(id) ON DELETE CASCADE,
  CONSTRAINT fk_bid_lignes_materiel_catalogue FOREIGN KEY (materiel_catalogue_id) REFERENCES public.materiel_catalogue(id) ON DELETE SET NULL
);
COMMENT ON TABLE public.bid_lignes IS 'Pricing/matching decisions for each marche_ligne';
COMMENT ON COLUMN public.bid_lignes.materiel_catalogue_id IS 'Selected catalogue item (null if not filled)';
COMMENT ON COLUMN public.bid_lignes.prix_fourniture IS 'Material/product price (HT)';
COMMENT ON COLUMN public.bid_lignes.prix_pose IS 'Installation/labor price (HT)';
COMMENT ON COLUMN public.bid_lignes.statut IS 'Pricing status (non_rempli, suggere, verifie)';

-- soumissions: Formal bids/quotations
CREATE TABLE IF NOT EXISTS public.soumissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chantier_id UUID NOT NULL,
  date TIMESTAMP WITH TIME ZONE DEFAULT now(),
  statut TEXT DEFAULT 'brouillon',
  total_ht NUMERIC(12, 2) DEFAULT 0,
  tva_pct NUMERIC(5, 2) DEFAULT 20,
  total_ttc NUMERIC(12, 2) DEFAULT 0,
  remise_pct NUMERIC(5, 2) DEFAULT 0,
  CONSTRAINT fk_soumissions_chantier FOREIGN KEY (chantier_id) REFERENCES public.chantiers(id) ON DELETE CASCADE
);
COMMENT ON TABLE public.soumissions IS 'Formal quotations/bids for chantiers';
COMMENT ON COLUMN public.soumissions.statut IS 'Bid status (brouillon, validee, envoyee, acceptee, refusee)';
COMMENT ON COLUMN public.soumissions.total_ht IS 'Total price before VAT (€)';
COMMENT ON COLUMN public.soumissions.tva_pct IS 'VAT percentage (default 20%)';
COMMENT ON COLUMN public.soumissions.total_ttc IS 'Total price after VAT (€)';
COMMENT ON COLUMN public.soumissions.remise_pct IS 'Discount percentage (0-100)';

-- ============================================================================
-- 3. CREATE INDEXES FOR PERFORMANCE
-- ============================================================================

CREATE INDEX idx_chantiers_created_by ON public.chantiers(created_by);
CREATE INDEX idx_chantiers_statut ON public.chantiers(statut);
CREATE INDEX idx_marches_chantier_id ON public.marches(chantier_id);
CREATE INDEX idx_marche_lignes_marche_id ON public.marche_lignes(marche_id);
CREATE INDEX idx_marche_lignes_ordre ON public.marche_lignes(marche_id, ordre);
CREATE INDEX idx_materiel_catalogue_fournisseur ON public.materiel_catalogue(fournisseur_id);
CREATE INDEX idx_materiel_catalogue_categorie ON public.materiel_catalogue(categorie);
CREATE INDEX idx_materiel_catalogue_statut ON public.materiel_catalogue(statut);
CREATE INDEX idx_catalogue_staging_fournisseur ON public.catalogue_staging(fournisseur_id);
CREATE INDEX idx_bid_lignes_marche_ligne_id ON public.bid_lignes(marche_ligne_id);
CREATE INDEX idx_bid_lignes_materiel_catalogue_id ON public.bid_lignes(materiel_catalogue_id);
CREATE INDEX idx_bid_lignes_statut ON public.bid_lignes(statut);
CREATE INDEX idx_soumissions_chantier_id ON public.soumissions(chantier_id);
CREATE INDEX idx_user_roles_user_id ON public.user_roles(user_id);

-- ============================================================================
-- 4. CREATE HELPER FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;
COMMENT ON FUNCTION public.has_role IS 'Check if a user has a specific role';

-- ============================================================================
-- 5. CREATE RLS (Row Level Security) POLICIES
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chantiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marche_lignes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fourniseeur ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.materiel_catalogue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalogue_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bid_lignes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.soumissions ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can only read their own profile
CREATE POLICY "profiles_self_read" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "profiles_insert_on_signup" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- User roles: Only admin can view/manage roles
CREATE POLICY "user_roles_admin_read" ON public.user_roles
  FOR SELECT USING (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "user_roles_admin_write" ON public.user_roles
  FOR INSERT WITH CHECK (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "user_roles_admin_update" ON public.user_roles
  FOR UPDATE USING (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Chantiers: All authenticated users can read, only admin can create/delete
CREATE POLICY "chantiers_read_all" ON public.chantiers
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "chantiers_admin_write" ON public.chantiers
  FOR INSERT WITH CHECK (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "chantiers_admin_delete" ON public.chantiers
  FOR DELETE USING (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Marches: All authenticated users can read
CREATE POLICY "marches_read_all" ON public.marches
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Marche lignes: All authenticated users can read
CREATE POLICY "marche_lignes_read_all" ON public.marche_lignes
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- fourniseeur: All authenticated users can read, admin can manage
CREATE POLICY "fourniseeur_read_all" ON public.fourniseeur
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "fourniseeur_admin_write" ON public.fourniseeur
  FOR INSERT WITH CHECK (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "fourniseeur_admin_delete" ON public.fourniseeur
  FOR DELETE USING (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Materiel catalogue: All authenticated users can read, admin can manage
CREATE POLICY "materiel_catalogue_read_all" ON public.materiel_catalogue
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "materiel_catalogue_admin_write" ON public.materiel_catalogue
  FOR INSERT WITH CHECK (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "materiel_catalogue_admin_update" ON public.materiel_catalogue
  FOR UPDATE USING (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "materiel_catalogue_admin_delete" ON public.materiel_catalogue
  FOR DELETE USING (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Catalogue staging: Admin only
CREATE POLICY "catalogue_staging_admin_all" ON public.catalogue_staging
  FOR ALL USING (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Bid lignes: All authenticated users can read
CREATE POLICY "bid_lignes_read_all" ON public.bid_lignes
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Soumissions: All authenticated users can read
CREATE POLICY "soumissions_read_all" ON public.soumissions
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ============================================================================
-- End of Schema Setup
-- ============================================================================