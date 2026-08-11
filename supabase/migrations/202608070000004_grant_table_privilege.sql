-- Fixes: "permission denied for table X" errors on tables created via raw
-- SQL migrations (as opposed to the Supabase Studio table editor).
--
-- RLS policies only control WHICH ROWS a role can see/touch once it's
-- already allowed to run the operation. The underlying GRANT is what
-- allows the operation at all. Tables created through Studio get these
-- grants automatically; tables created via `supabase db push` / raw SQL
-- do not, unless you grant them explicitly. That's why user_roles (and
-- likely every other table below) was silently returning no data to the
-- app instead of throwing a visible RLS-style block.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO authenticated;

GRANT SELECT
  ON ALL TABLES IN SCHEMA public
  TO anon;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Make sure future tables (new migrations) get the same grants automatically,
-- so this class of bug doesn't resurface with the next table you add.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;