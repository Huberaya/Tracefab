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
-- Cette migration est également exercée par des scénarios CI qui reconstruisent
-- volontairement une chaîne partielle. Les ACL du graphe ne sont touchées que si
-- les deux tables existent; si la migration de graphe est enregistrée comme
-- appliquée mais que ses tables manquent, on échoue au lieu de masquer le drift.

DO $reconcile_runtime_privileges$
DECLARE
  role_ok boolean;
  graph_migration_applied boolean;
  graph_tables_exist boolean;
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

  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'Migration refusée : historique Prisma absent';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public._prisma_migrations
    WHERE migration_name = '20261020120000_structured_supply_chain_graph_membership'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
  ) INTO graph_migration_applied;

  SELECT to_regclass('public.supply_chain_links') IS NOT NULL
     AND to_regclass('public.supply_chain_nodes') IS NOT NULL
    INTO graph_tables_exist;

  IF graph_migration_applied AND NOT graph_tables_exist THEN
    RAISE EXCEPTION
      'Migration refusée : la migration du graphe est enregistrée comme appliquée mais ses tables sont absentes';
  END IF;

  -- La mutation du graphe passe par les fonctions contrôlées. Conserver SELECT
  -- pour les lectures Prisma et fermer le DML direct, y compris via PUBLIC.
  IF graph_tables_exist THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.supply_chain_links, public.supply_chain_nodes FROM tracefab_app';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.supply_chain_links, public.supply_chain_nodes FROM PUBLIC';
    EXECUTE 'GRANT SELECT ON TABLE public.supply_chain_links, public.supply_chain_nodes TO tracefab_app';

    IF has_table_privilege('tracefab_app', 'public.supply_chain_links', 'INSERT')
       OR has_table_privilege('tracefab_app', 'public.supply_chain_links', 'UPDATE')
       OR has_table_privilege('tracefab_app', 'public.supply_chain_links', 'DELETE')
       OR has_table_privilege('tracefab_app', 'public.supply_chain_nodes', 'INSERT')
       OR has_table_privilege('tracefab_app', 'public.supply_chain_nodes', 'UPDATE')
       OR has_table_privilege('tracefab_app', 'public.supply_chain_nodes', 'DELETE')
       OR has_table_privilege('tracefab_app', 'public.supply_chain_links', 'SELECT') IS NOT TRUE
       OR has_table_privilege('tracefab_app', 'public.supply_chain_nodes', 'SELECT') IS NOT TRUE THEN
      RAISE EXCEPTION
        'Postcondition échouée : privilèges runtime non conformes sur les tables du graphe';
    END IF;
  END IF;

  -- Le runtime ne peut pas réécrire ou effacer les preuves de migration.
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM tracefab_app';

  IF has_table_privilege('tracefab_app', 'public._prisma_migrations', 'INSERT')
     OR has_table_privilege('tracefab_app', 'public._prisma_migrations', 'UPDATE')
     OR has_table_privilege('tracefab_app', 'public._prisma_migrations', 'DELETE') THEN
    RAISE EXCEPTION
      'Postcondition échouée : le rôle runtime peut encore modifier l''historique Prisma';
  END IF;
END
$reconcile_runtime_privileges$;
