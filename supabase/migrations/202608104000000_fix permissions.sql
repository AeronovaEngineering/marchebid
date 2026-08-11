-- ============================================================================
-- FIX: Grant permissions on all tables for authenticated users
-- ============================================================================

-- Grant USAGE on schema (this is often missed)
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Grant ALL permissions on ALL tables (including marches and materiel_catalogue)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;

-- Grant SELECT only for anonymous users (if needed)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;

-- Make sure sequences are accessible
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
  GRANT ALL PRIVILEGES ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
  GRANT ALL PRIVILEGES ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
  GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;

-- ============================================================================
-- Specifically for your two problematic tables
-- ============================================================================

-- marches table
GRANT ALL PRIVILEGES ON TABLE public.marches TO authenticated;
GRANT SELECT ON TABLE public.marches TO anon;

-- materiel_catalogue table  
GRANT ALL PRIVILEGES ON TABLE public.materiel_catalogue TO authenticated;
GRANT SELECT ON TABLE public.materiel_catalogue TO anon;

-- marche_lignes (needed for the import)
GRANT ALL PRIVILEGES ON TABLE public.marche_lignes TO authenticated;
GRANT SELECT ON TABLE public.marche_lignes TO anon;

-- bid_lignes (needed for the import)
GRANT ALL PRIVILEGES ON TABLE public.bid_lignes TO authenticated;
GRANT SELECT ON TABLE public.bid_lignes TO anon;

-- ============================================================================
-- Verify permissions
-- ============================================================================

-- Check current grants on marches
SELECT 
  schemaname,
  tablename,
  usename,
  privilege_type
FROM 
  pg_tables 
  JOIN pg_user ON pg_tables.schemaname = 'public'
  LEFT JOIN information_schema.table_privileges 
    ON table_privileges.table_name = pg_tables.tablename
WHERE 
  pg_tables.tablename IN ('marches', 'materiel_catalogue');