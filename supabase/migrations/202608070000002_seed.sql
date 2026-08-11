-- ============================================================================
-- AeroNova BID Database - Sample Data Seed
-- ============================================================================
-- Run this AFTER 001_init_schema.sql and after renaming fourniseeur -> fournisseurs
-- ============================================================================

-- ============================================================================
-- 1. SEED PROFILES (link to auth.users)
-- ============================================================================
INSERT INTO public.profiles (id, email, nom, actif, created_at)
VALUES (
  '0527767a-9126-4257-8b36-628783192900',
  'aeronova.admin@gmail.com',
  'Administrator',
  true,
  now()
)
ON CONFLICT (id) DO UPDATE SET nom = EXCLUDED.nom;

-- ============================================================================
-- 2. SEED USER ROLES
-- ============================================================================
INSERT INTO public.user_roles (user_id, role)
VALUES ('0527767a-9126-4257-8b36-628783192900', 'admin')
ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role;

-- ============================================================================
-- 3. SEED fournisseurs (Suppliers)
-- ============================================================================

INSERT INTO public.fournisseurs (id, nom, contact, telephone, email, notes)
VALUES (
  gen_random_uuid(), 'SOPRO', 'Pierre Dubois', '+216 71 123 456', 'contact@sopro.tn',
  'Spécialiste en tuyauterie multicouche, PVC et cuivre. Délai livraison: 3-5 jours'
)
ON CONFLICT (nom) DO NOTHING;

INSERT INTO public.fournisseurs (id, nom, contact, telephone, email, notes)
VALUES (
  gen_random_uuid(), 'SANITEX', 'Fatma Ben Ali', '+216 71 234 567', 'commercial@sanitex.tn',
  'Équipements sanitaires complets. Stock permanent. Assistance technique disponible'
)
ON CONFLICT (nom) DO NOTHING;

INSERT INTO public.fournisseurs (id, nom, contact, telephone, email, notes)
VALUES (
  gen_random_uuid(), 'CLIM''PRO', 'Karim Saf', '+216 71 345 678', 'ventes@climpro.tn',
  'Systèmes de climatisation et ventilation. Installation disponible'
)
ON CONFLICT (nom) DO NOTHING;

INSERT INTO public.fournisseurs (id, nom, contact, telephone, email, notes)
VALUES (
  gen_random_uuid(), 'GAZ''TUN', 'Mohamed Gharbi', '+216 71 456 789', 'info@gazatun.tn',
  'Tuyauterie cuivre et gaz. Certification ISO. Tests étanchéité inclus'
)
ON CONFLICT (nom) DO NOTHING;

-- ============================================================================
-- 4. SEED MATERIEL CATALOGUE (Products from suppliers)
-- ============================================================================

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Tube multicouche PER 16x2', 'ml', 2.50, 'Tuyauterie', 'Multicouche', '{"diametre":"16mm","epaisseur":"2mm","pression":"10bar"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'SOPRO' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Tube multicouche PER 20x2', 'ml', 3.20, 'Tuyauterie', 'Multicouche', '{"diametre":"20mm","epaisseur":"2mm","pression":"10bar"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'SOPRO' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Tube PVC 32', 'ml', 1.80, 'Tuyauterie', 'PVC', '{"diametre":"32mm","type":"assainissement","pression":"0bar"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'SOPRO' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Vanne d''arrêt 3/4" laiton', 'u', 8.90, 'Robinets', 'Vannes', '{"type":"boule","materiel":"laiton","raccord":"3/4 pouce"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'SOPRO' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Clapet antiretour 1" laiton', 'u', 12.50, 'Robinets', 'Clapets', '{"type":"antiretour","materiel":"laiton","raccord":"1 pouce","pression":"10bar"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'SOPRO' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Lavabo céramique blanc 60x45', 'u', 45.00, 'Sanitaires', 'Lavabos', '{"type":"céramique","longueur":"60cm","profondeur":"45cm","couleur":"blanc"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'SANITEX' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Baignoire acrylique 170x75', 'u', 120.00, 'Sanitaires', 'Baignoires', '{"type":"acrylique","longueur":"170cm","largeur":"75cm","profondeur":"60cm"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'SANITEX' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'WC porcelaine suspendu', 'u', 85.00, 'Sanitaires', 'WC', '{"type":"suspendu","materiel":"porcelaine","chasse":"double 3L/6L"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'SANITEX' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Robinetterie mélangeur chromé', 'u', 35.00, 'Sanitaires', 'Robinetterie', '{"type":"mélangeur","finition":"chromée","débit":"6L/min"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'SANITEX' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Climatiseur split 12000 BTU', 'u', 450.00, 'Climatisation', 'Splits', '{"puissance":"12000 BTU","type":"split","efficacite":"A++","refrigerant":"R32"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'CLIM''PRO' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Extracteur d''air 120mm', 'u', 25.00, 'Ventilation', 'Extracteurs', '{"diametre":"120mm","debit":"200m3/h","bruit":"35dB"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'CLIM''PRO' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Gaine alu TN 125', 'ml', 3.50, 'Ventilation', 'Gaines', '{"diametre":"125mm","materiel":"aluminium","isolation":true}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'CLIM''PRO' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Tube cuivre 12x1 (gaz)', 'ml', 2.20, 'Gaz', 'Tuyauterie cuivre', '{"diametre":"12mm","epaisseur":"1mm","type":"gaz","certification":"ISO"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'GAZ''TUN' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Vanne gaz 1/2" bronze', 'u', 15.00, 'Gaz', 'Vannes gaz', '{"type":"boule","materiel":"bronze","raccord":"1/2 pouce","certif":"gaz"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'GAZ''TUN' ON CONFLICT DO NOTHING;

INSERT INTO public.materiel_catalogue (fournisseur_id, designation, unite, prix_fourniture, categorie, sous_categorie, specs, statut)
SELECT f.id, 'Flexible gaz 1 m', 'u', 8.50, 'Gaz', 'Flexibles', '{"type":"flexible","longueur":"1m","certif":"gaz"}'::jsonb, 'verifie'
FROM public.fournisseurs f WHERE f.nom = 'GAZ''TUN' ON CONFLICT DO NOTHING;

-- ============================================================================
-- 5. SEED CHANTIERS (Construction Projects)
-- ============================================================================

INSERT INTO public.chantiers (id, nom, client, lieu, statut, created_by)
VALUES (gen_random_uuid(), 'MANDARIN Blocs B-C', 'MANDARIN IMMOBILIER', 'Cité Administratif, Tunis', 'brouillon', '0527767a-9126-4257-8b36-628783192900')
ON CONFLICT DO NOTHING;

INSERT INTO public.chantiers (id, nom, client, lieu, statut, created_by)
VALUES (gen_random_uuid(), 'Hôtel El Habibi', 'EL HABIBI HOTELS', 'Hammamet', 'en_cours', '0527767a-9126-4257-8b36-628783192900')
ON CONFLICT DO NOTHING;

INSERT INTO public.chantiers (id, nom, client, lieu, statut, created_by)
VALUES (gen_random_uuid(), 'Extension Polyclinique Ibn Sina', 'POLYCLINIQUE IBN SINA', 'La Marsa', 'brouillon', '0527767a-9126-4257-8b36-628783192900')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 6. SEED MARCHES (Lots) for the main project
-- ============================================================================

INSERT INTO public.marches (id, chantier_id, lot, fichier_original, format_detecte, date_import)
SELECT gen_random_uuid(), c.id, 'Fluides', 'mandarin_fluides.xlsx', 'xlsx', now()
FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' ON CONFLICT DO NOTHING;

INSERT INTO public.marches (id, chantier_id, lot, fichier_original, format_detecte, date_import)
SELECT gen_random_uuid(), c.id, 'Électricité', 'mandarin_electricite.xlsx', 'xlsx', now()
FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' ON CONFLICT DO NOTHING;

-- ============================================================================
-- 7. SEED MARCHE_LIGNES (Line Items) for Fluides lot
-- ============================================================================

INSERT INTO public.marche_lignes (id, marche_id, numero, designation, quantite, unite, chapitre_ou_zone, a_pose, ordre)
SELECT gen_random_uuid(), m.id, 'I.1', 'Fourniture et pose de tuyauterie multicouche PER 16x2 dans les murs', 250.00, 'ml', 'I - Tuyauterie alimentation eau froide', true, 1
FROM public.marches m WHERE m.lot = 'Fluides' AND EXISTS (SELECT 1 FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' AND c.id = m.chantier_id) ON CONFLICT DO NOTHING;

INSERT INTO public.marche_lignes (id, marche_id, numero, designation, quantite, unite, chapitre_ou_zone, a_pose, ordre)
SELECT gen_random_uuid(), m.id, 'I.2', 'Fourniture et pose de tuyauterie multicouche PER 20x2 dans les murs', 180.00, 'ml', 'I - Tuyauterie alimentation eau froide', true, 2
FROM public.marches m WHERE m.lot = 'Fluides' AND EXISTS (SELECT 1 FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' AND c.id = m.chantier_id) ON CONFLICT DO NOTHING;

INSERT INTO public.marche_lignes (id, marche_id, numero, designation, quantite, unite, chapitre_ou_zone, a_pose, ordre)
SELECT gen_random_uuid(), m.id, 'I.3', 'Fourniture et pose de robinets d''arrêt en laiton 3/4"', 12.00, 'u', 'I - Tuyauterie alimentation eau froide', true, 3
FROM public.marches m WHERE m.lot = 'Fluides' AND EXISTS (SELECT 1 FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' AND c.id = m.chantier_id) ON CONFLICT DO NOTHING;

INSERT INTO public.marche_lignes (id, marche_id, numero, designation, quantite, unite, chapitre_ou_zone, a_pose, ordre)
SELECT gen_random_uuid(), m.id, 'II.1', 'Fourniture et pose de clapets antiretour 1" laiton', 6.00, 'u', 'II - Clapets & Vannes', true, 4
FROM public.marches m WHERE m.lot = 'Fluides' AND EXISTS (SELECT 1 FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' AND c.id = m.chantier_id) ON CONFLICT DO NOTHING;

INSERT INTO public.marche_lignes (id, marche_id, numero, designation, quantite, unite, chapitre_ou_zone, a_pose, ordre)
SELECT gen_random_uuid(), m.id, 'III.1', 'Fourniture et pose de lavabos céramique blanc 60x45', 8.00, 'u', 'III - Sanitaires', true, 5
FROM public.marches m WHERE m.lot = 'Fluides' AND EXISTS (SELECT 1 FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' AND c.id = m.chantier_id) ON CONFLICT DO NOTHING;

INSERT INTO public.marche_lignes (id, marche_id, numero, designation, quantite, unite, chapitre_ou_zone, a_pose, ordre)
SELECT gen_random_uuid(), m.id, 'III.2', 'Fourniture et pose de baignoires acrylique 170x75', 3.00, 'u', 'III - Sanitaires', true, 6
FROM public.marches m WHERE m.lot = 'Fluides' AND EXISTS (SELECT 1 FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' AND c.id = m.chantier_id) ON CONFLICT DO NOTHING;

INSERT INTO public.marche_lignes (id, marche_id, numero, designation, quantite, unite, chapitre_ou_zone, a_pose, ordre)
SELECT gen_random_uuid(), m.id, 'III.3', 'Fourniture et pose de WC porcelaine suspendus', 8.00, 'u', 'III - Sanitaires', true, 7
FROM public.marches m WHERE m.lot = 'Fluides' AND EXISTS (SELECT 1 FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' AND c.id = m.chantier_id) ON CONFLICT DO NOTHING;

INSERT INTO public.marche_lignes (id, marche_id, numero, designation, quantite, unite, chapitre_ou_zone, a_pose, ordre)
SELECT gen_random_uuid(), m.id, 'III.4', 'Fourniture et pose de robinetterie mélangeur chromé', 8.00, 'u', 'III - Sanitaires', true, 8
FROM public.marches m WHERE m.lot = 'Fluides' AND EXISTS (SELECT 1 FROM public.chantiers c WHERE c.nom = 'MANDARIN Blocs B-C' AND c.id = m.chantier_id) ON CONFLICT DO NOTHING;

-- ============================================================================
-- 8. SEED BID_LIGNES (empty pricing entries for the line items)
-- ============================================================================

INSERT INTO public.bid_lignes (marche_ligne_id, statut)
SELECT ml.id, 'non_rempli'
FROM public.marche_lignes ml
WHERE EXISTS (
  SELECT 1 FROM public.marches m
  WHERE m.id = ml.marche_id AND m.lot = 'Fluides'
  AND EXISTS (SELECT 1 FROM public.chantiers c WHERE c.id = m.chantier_id AND c.nom = 'MANDARIN Blocs B-C')
)
ON CONFLICT (marche_ligne_id) DO NOTHING;