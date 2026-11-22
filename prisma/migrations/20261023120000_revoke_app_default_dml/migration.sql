-- Révoquer les privilèges DML héritables sur les futures tables publiques.
--
-- Les ACL des tables existantes et les privilèges par défaut sont indépendants.
-- La matrice DML des tables existantes peut être minimale alors que chaque
-- nouvelle table créée par le propriétaire réaccorde INSERT/UPDATE/DELETE.
-- PostgreSQL distingue aussi les defaults globaux des defaults propres à un
-- schéma : les deux portées sont nettoyées.

DO $revoke_app_default_dml$
DECLARE
  app_role_oid oid;
  owner_row record;
  current_is_super boolean;
BEGIN
  SELECT oid INTO app_role_oid FROM pg_roles WHERE rolname = 'tracefab_app';
  IF app_role_oid IS NULL THEN
    RAISE EXCEPTION 'Migration refusée : rôle tracefab_app absent';
  END IF;

  SELECT rolsuper INTO current_is_super
  FROM pg_roles WHERE rolname = current_user;

  FOR owner_row IN
    SELECT DISTINCT d.defaclrole, owner.rolname
    FROM pg_default_acl d
    JOIN pg_roles owner ON owner.oid = d.defaclrole
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype = 'r'
      AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
      AND a.grantee IN (0, app_role_oid)
      AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  LOOP
    IF NOT current_is_super AND NOT pg_has_role(current_user, owner_row.defaclrole, 'MEMBER') THEN
      RAISE EXCEPTION
        'Migration refusée : % doit révoquer les privilèges DML par défaut du propriétaire %',
        current_user, owner_row.rolname;
    END IF;

    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE INSERT, UPDATE, DELETE ON TABLES FROM tracefab_app',
      owner_row.rolname
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM tracefab_app',
      owner_row.rolname
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE INSERT, UPDATE, DELETE ON TABLES FROM PUBLIC',
      owner_row.rolname
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM PUBLIC',
      owner_row.rolname
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype = 'r'
      AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
      AND a.grantee IN (0, app_role_oid)
      AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION
      'Postcondition échouée : des privilèges DML par défaut subsistent pour tracefab_app ou PUBLIC';
  END IF;
END
$revoke_app_default_dml$;
