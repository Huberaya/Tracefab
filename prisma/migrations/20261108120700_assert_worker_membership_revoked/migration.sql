-- ============================================================================
-- 20261108120700 — garde terminale : le migrateur ne conserve pas l'identité worker
--
-- MIGRATION ADDITIVE. Elle ne modifie aucune migration déjà appliquée.
--
-- Sur Neon, cloud_admin accorde automatiquement ADMIN OPTION au créateur d'un
-- rôle. Le rôle historique a donc été isolé sous tracefab_worker_legacy ; il ne
-- possède plus aucun objet ni privilège. Le nouveau tracefab_worker est créé
-- par neondb_owner, puis le runner ne lui accorde au migrateur que SET/INHERIT
-- temporaire, sans ADMIN OPTION.
--
-- scripts/provisionner_worker_neon.mjs réalise ce préflight hors historique
-- Prisma (il ne touche jamais _prisma_migrations). Cette migration vérifie son
-- résultat et refuse toute dérive. Sur PostgreSQL jetable sans cloud_admin,
-- cette étape Neon n'est pas nécessaire.
--
-- Cette migration ne tente aucun REVOKE : elle échoue fermé si le runner n'a
-- pas retiré l'appartenance temporaire au nouveau worker avant le COMMIT.
-- ============================================================================

DO $worker_membership_terminal$
DECLARE
  v_worker oid;
  v_legacy oid;
  v_migrator oid;
  v_app oid;
  v_cloud_admin oid;
  v_count integer;
  v_attrs record;
BEGIN
  SELECT oid INTO v_worker FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker';
  SELECT oid INTO v_legacy FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker_legacy';
  SELECT oid INTO v_migrator FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_migrator';
  SELECT oid INTO v_app FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app';
  SELECT oid INTO v_cloud_admin FROM pg_catalog.pg_roles WHERE rolname = 'cloud_admin';

  IF v_migrator IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE oid = v_migrator AND rolsuper IS TRUE
  ) THEN
    RAISE EXCEPTION 'tracefab_migrator_superuser_residuel'
      USING HINT = 'Le rôle de migration doit être NOSUPERUSER avant la migration terminale.';
  END IF;

  -- Si Neon a géré le grant mais que le préflight n'a pas renommé l'ancien
  -- rôle, ne pas accepter une appartenance ADMIN OPTION sous le nom actif.
  IF v_cloud_admin IS NOT NULL AND v_legacy IS NULL
     AND v_worker IS NOT NULL AND v_migrator IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members x
        WHERE x.member = v_migrator AND x.roleid = v_worker
          AND x.grantor = v_cloud_admin AND x.admin_option IS TRUE
          AND x.inherit_option IS FALSE AND x.set_option IS FALSE
     ) THEN
    RAISE EXCEPTION 'tracefab_worker_neon_preflight_required'
      USING HINT = 'Exécuter npm run db:preflight:worker-neon avec les deux URLs Neon avant la chaîne de migrations.';
  END IF;

  IF v_worker IS NOT NULL THEN
    SELECT * INTO v_attrs FROM pg_catalog.pg_roles WHERE oid = v_worker;
    IF v_attrs.rolcanlogin OR v_attrs.rolsuper OR v_attrs.rolbypassrls
       OR v_attrs.rolcreaterole OR v_attrs.rolcreatedb OR v_attrs.rolreplication
       OR v_attrs.rolinherit
       OR pg_catalog.has_schema_privilege(v_worker, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'tracefab_worker_attributes_or_schema_privilege_invalid'
        USING HINT = 'tracefab_worker doit être NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT et sans CREATE sur public.';
    END IF;
  END IF;

  IF v_migrator IS NOT NULL AND v_worker IS NOT NULL
     AND pg_catalog.pg_has_role(v_migrator, v_worker, 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_migrator_worker_membership_residuelle'
      USING HINT = 'Le runner doit révoquer tracefab_worker de tracefab_migrator avant la migration terminale.';
  END IF;

  IF v_app IS NOT NULL AND v_worker IS NOT NULL
     AND pg_catalog.pg_has_role(v_app, v_worker, 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_app_member_of_worker'
      USING HINT = 'Le rôle applicatif ne doit jamais endosser tracefab_worker.';
  END IF;

  IF v_legacy IS NOT NULL THEN
    SELECT * INTO v_attrs FROM pg_catalog.pg_roles WHERE oid = v_legacy;
    IF v_attrs.rolcanlogin OR v_attrs.rolsuper OR v_attrs.rolbypassrls
       OR v_attrs.rolcreaterole OR v_attrs.rolcreatedb OR v_attrs.rolreplication
       OR v_attrs.rolinherit THEN
      RAISE EXCEPTION 'tracefab_worker_legacy_attributes_invalid'
        USING HINT = 'Le rôle historique doit être NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB et NOINHERIT.';
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_shdepend
       WHERE refobjid = v_legacy AND deptype = 'o'
    ) THEN
      RAISE EXCEPTION 'tracefab_worker_legacy_owns_objects'
        USING HINT = 'Transférer tous les objets propriétaires vers le nouveau tracefab_worker.';
    END IF;

    SELECT
      (SELECT count(*) FROM pg_catalog.pg_class c
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee = v_legacy)
      +
      (SELECT count(*) FROM pg_catalog.pg_proc p
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee = v_legacy)
      +
      (SELECT count(*) FROM pg_catalog.pg_namespace n
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
        WHERE a.grantee = v_legacy)
      +
      (SELECT count(*) FROM pg_catalog.pg_type t
        CROSS JOIN LATERAL pg_catalog.aclexplode(t.typacl) a
        WHERE t.typacl IS NOT NULL AND a.grantee=v_legacy)
      +
      (SELECT count(*) FROM pg_catalog.pg_default_acl WHERE defaclrole=v_legacy)
      +
      (SELECT count(*) FROM pg_catalog.pg_database WHERE datacl::text LIKE '%tracefab_worker_legacy%')
      +
      (SELECT count(*) FROM pg_catalog.pg_language WHERE lanacl::text LIKE '%tracefab_worker_legacy%')
      +
      (SELECT count(*) FROM pg_catalog.pg_foreign_server WHERE srvacl::text LIKE '%tracefab_worker_legacy%')
      +
      (SELECT count(*) FROM pg_catalog.pg_foreign_data_wrapper WHERE fdwacl::text LIKE '%tracefab_worker_legacy%')
      +
      (SELECT count(*) FROM pg_catalog.pg_largeobject_metadata WHERE lomacl::text LIKE '%tracefab_worker_legacy%')
      +
      (SELECT count(*) FROM pg_catalog.pg_parameter_acl WHERE paracl::text LIKE '%tracefab_worker_legacy%')
      INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'tracefab_worker_legacy_acl_residuelle'
        USING HINT = 'Le rôle legacy doit être sans ACL, privilège de schéma ni privilège par défaut.';
    END IF;

    IF v_worker IS NOT NULL AND pg_catalog.pg_has_role(v_legacy, v_worker, 'MEMBER') THEN
      RAISE EXCEPTION 'tracefab_worker_legacy_member_of_worker'
        USING HINT = 'Le rôle legacy ne doit conserver aucune appartenance au nouveau worker.';
    END IF;

    IF v_migrator IS NOT NULL THEN
      SELECT count(*) INTO v_count
        FROM pg_catalog.pg_auth_members
       WHERE member = v_migrator AND roleid = v_legacy;
      IF v_cloud_admin IS NULL OR v_count <> 1 OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members x
         WHERE x.member = v_migrator AND x.roleid = v_legacy
           AND x.grantor = v_cloud_admin AND x.admin_option IS TRUE
           AND x.inherit_option IS FALSE AND x.set_option IS FALSE
      ) OR pg_catalog.pg_has_role(v_migrator, v_legacy, 'SET')
        OR pg_catalog.pg_has_role(v_migrator, v_legacy, 'USAGE') THEN
        RAISE EXCEPTION 'tracefab_worker_legacy_managed_membership_invalid'
          USING HINT = 'Seul le grant cloud_admin ADMIN OPTION, sans INHERIT ni SET, peut subsister sur un rôle legacy inerte.';
      END IF;
    END IF;

    IF v_app IS NOT NULL AND pg_catalog.pg_has_role(v_app, v_legacy, 'MEMBER') THEN
      RAISE EXCEPTION 'tracefab_app_member_of_worker_legacy'
        USING HINT = 'Le rôle applicatif ne doit jamais être membre du rôle legacy.';
    END IF;
  END IF;
END
$worker_membership_terminal$;
