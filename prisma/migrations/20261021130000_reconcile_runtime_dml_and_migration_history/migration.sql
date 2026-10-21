-- Réconcilier les droits applicatifs après la création tardive du graphe supply-chain.
--
-- 20261019160000_retablir_dml_tables_ecrites_directement a restauré les droits
-- sur les tables alors présentes. La migration 20261020120000_structured_supply_chain_graph_membership
-- a créé/complété supply_chain_links et supply_chain_nodes APRÈS ce correctif :
-- les deux tables sont donc absentes des ACL applicatives en production alors
-- que l'API les écrit directement. La liste de provisioning doit être alignée.
--
-- L'historique Prisma est une table d'exploitation, pas une table métier.
-- Le rôle de runtime ne doit ni modifier ni supprimer les preuves de migration.
--
-- Fail closed : ne pas enregistrer cette migration si le rôle cible est absent
-- ou si ses attributs contredisent le principe d'un rôle applicatif soumis à RLS.

BEGIN;

DO $reconcile_runtime_privileges$
DECLARE
  role_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_roles
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
     OR to_regclass('public.supply_chain_nodes') IS NULL THEN
    RAISE EXCEPTION
      'Migration refusée : les tables supply_chain_links et supply_chain_nodes doivent exister avant leur ACL runtime';
  END IF;

  -- Ces deux tables ont été créées après la migration qui réconciliait le DML.
  -- Accorder seulement les opérations utilisées par l'API, jamais TRUNCATE,
  -- REFERENCES ou TRIGGER.
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.supply_chain_links, public.supply_chain_nodes FROM PUBLIC';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supply_chain_links, public.supply_chain_nodes TO tracefab_app';

  -- Le runtime n'a aucune raison de réécrire ou d'effacer l'historique Prisma.
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM tracefab_app';

  -- Vérification postcondition dans la même transaction.
  IF has_table_privilege('tracefab_app', 'public.supply_chain_links', 'INSERT') IS NOT TRUE
     OR has_table_privilege('tracefab_app', 'public.supply_chain_nodes', 'INSERT') IS NOT TRUE
     OR has_table_privilege('tracefab_app', 'public._prisma_migrations', 'UPDATE')
     OR has_table_privilege('tracefab_app', 'public._prisma_migrations', 'DELETE')
     OR has_table_privilege('tracefab_app', 'public._prisma_migrations', 'INSERT') THEN
    RAISE EXCEPTION
      'Postcondition échouée : privilèges runtime non conformes après réconciliation';
  END IF;
END
$reconcile_runtime_privileges$;

COMMIT;
