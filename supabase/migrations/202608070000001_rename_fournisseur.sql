-- Renames the misspelled "fourniseeur" table (from the original init_schema
-- migration) to "fournisseurs", matching the already-corrected frontend
-- code. Must run AFTER 202608050000000_init_schema.sql and BEFORE
-- 202608050000001_seed_data.sql -- name it so it sorts between them, e.g.
-- 202608050000000b_rename_fourniseeur.sql, or just paste this at the very
-- top of your seed_data.sql file, before the first INSERT.

ALTER TABLE public.fourniseeur RENAME TO fournisseurs;