-- Réconcilier les privilèges runtime après la création tardive du graphe supply-chain.
--
-- Les migrations de graphe créent supply_chain_links et supply_chain_nodes après
-- le correctif DML historique. L'API modifie ces tables via des fonctions
-- SECURITY DEFINER, pas par DML Prisma direct : le rôle runtime ne doit donc
-- PAS recevoir INSERT/UPDATE/DELETE sur ces tables.
--
-- La table _prisma_migrations est une preuve d'exploitation : le rôle runtime
-- ne doit ni la modifier ni la supprimer.
--
-- Fail closed si tracefab_app est absent ou doté de privilèges incompatibles
-- avec un rôle applicatif soumis à RLS.

DO $reconcile_runtime_privileges$
DECLARE
  role_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'tracefab_app'
      AND rolcanlogin
      AND NOT rolsuper
      AND NOT rolbypassrls
      AND NOT rolcreaterole
      AND NOT rolcreatedb
  ) INTO role_ok;

  IF NOT role_ok THEN
    RAISE EXCEPTION
      'Migration refusée : tracefab_app absent ou doté de privilèges incompatibles avec un rôle runtime soumis à RLS';
  END IF;

  IF to_regclass('public.supply_chain_links') IS NULL
     OR to_regclass('public.supply_chain_nodes') IS NULL
     OR to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION
      'Migration refusée : tables supply-chain ou historique Prisma absentes';
  END IF;

  -- La mutation du graphe passe par les fonctions contrôlées. Conserver SELECT
  -- pour les lectures Prisma et fermer le DML direct, y compris via PUBLIC.
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.supply_chain_links, public.supply_chain_nodes FROM tracefab_app';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.supply_chain_links, public.supply_chain_nodes FROM PUBLIC';
  EXECUTE 'GRANT SELECT ON TABLE public.supply_chain_links, public.supply_chain_nodes TO tracefab_app';

  -- Le runtime ne peut pas réécrire ou effacer les preuves de migration.
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM tracefab_app';

  -- Postconditions explicites : accès en écriture refusé aux tables du graphe
  -- et à l'historique, tout en gardant la lecture du graphe.
  IF has_table_privilege('tracefab_app', 'public.supply_chain_links', 'INSERT')
     OR has_table_privilege('tracefab_app', 'public.supply_chain_links', 'UPDATE')
     OR has_table_privilege('tracefab_app', 'public.supply_chain_links', 'DELETE')
     OR has_table_privilege('tracefab_app', 'public.supply_chain_nodes', 'INSERT')
     OR has_table_privilege('tracefab_app', 'public.supply_chain_nodes', 'UPDATE')
     OR has_table_privilege('tracefab_app', 'public.supply_chain_nodes', 'DELETE')
     OR has_table_privilege('tracefab_app', 'public._prisma_migrations', 'INSERT')
     OR has_table_privilege('tracefab_app', 'public._prisma_migrations', 'UPDATE')
     OR has_table_privilege('tracefab_app', 'public._prisma_migrations', 'DELETE')
     OR has_table_privilege('tracefab_app', 'public.supply_chain_links', 'SELECT') IS NOT TRUE
     OR has_table_privilege('tracefab_app', 'public.supply_chain_nodes', 'SELECT') IS NOT TRUE THEN
    RAISE EXCEPTION
      'Postcondition échouée : privilèges runtime non conformes après réconciliation';
  END IF;
END
$reconcile_runtime_privileges$;
