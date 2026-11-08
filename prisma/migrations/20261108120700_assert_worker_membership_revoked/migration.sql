-- ============================================================================
-- 20261108120700 — garde terminale : le migrateur ne conserve pas l'identité worker
--
-- MIGRATION ADDITIVE. Elle ne modifie aucune migration déjà appliquée.
--
-- tracefab_worker possède des fonctions SECURITY DEFINER. Un rôle capable de
-- faire SET ROLE tracefab_worker peut agir comme l'identité système et franchir
-- l'isolation multi-tenant. Cette appartenance est un besoin temporaire du
-- processus de migration, jamais un privilège permanent.
--
-- scripts/migrer_fidelement.mjs accorde INHERIT/SET sans ADMIN dans la transaction
-- de chaque migration qui remplace une fonction worker, puis révoque et vérifie
-- l'absence avant le COMMIT. Un échec, un signal ou SIGKILL annule cette
-- transaction : l'appartenance ne peut pas survivre à la migration.
--
-- Cette migration ne tente pas de REVOKE : le rôle migrateur n'est pas grantor
-- de l'appartenance et ne possède pas ADMIN OPTION. Elle échoue fermé si le
-- runner n'a pas réalisé la révocation.
-- ============================================================================

DO $worker_membership_terminal$
DECLARE
  v_worker oid;
  v_migrator oid;
  v_app oid;
BEGIN
  SELECT oid INTO v_worker FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker';
  SELECT oid INTO v_migrator FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_migrator';
  SELECT oid INTO v_app FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app';

  IF v_migrator IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE oid = v_migrator AND rolsuper IS TRUE
  ) THEN
    RAISE EXCEPTION 'tracefab_migrator_superuser_residuel'
      USING HINT = 'Le rôle de migration doit être NOSUPERUSER avant la migration terminale.';
  END IF;

  IF v_worker IS NOT NULL AND v_migrator IS NOT NULL
     AND pg_catalog.pg_has_role(v_migrator, v_worker, 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_migrator_worker_membership_residuelle'
      USING HINT = 'Le runner doit révoquer tracefab_worker de tracefab_migrator avant la migration terminale.';
  END IF;

  IF v_worker IS NOT NULL AND v_app IS NOT NULL
     AND pg_catalog.pg_has_role(v_app, v_worker, 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_app_member_of_worker'
      USING HINT = 'Le rôle applicatif ne doit jamais endosser tracefab_worker.';
  END IF;
END
$worker_membership_terminal$;
