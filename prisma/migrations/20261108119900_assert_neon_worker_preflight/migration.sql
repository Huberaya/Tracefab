-- ============================================================================
-- 20261108119900 — précondition Neon : worker isolé avant la chaîne P10.7
--
-- ASSERTION ADDITIVE. Aucun objet, privilège, rôle ou historique n'est modifié.
-- Sur Neon, exécuter au préalable :
--   npm run db:preflight:worker-neon
-- Le préflight utilise DATABASE_URL (tracefab_migrator) et TF_ADMIN_URL
-- (neondb_owner), et ne touche jamais _prisma_migrations.
--
-- Sur PostgreSQL jetable sans cloud_admin, la contrainte fournisseur n'existe
-- pas : le contrôle Neon est ignoré ; les gardes 1202/1207 restent actives.
-- ============================================================================

DO $neon_worker_preflight$
DECLARE
  v_worker oid;
  v_legacy oid;
  v_migrator oid;
  v_app oid;
  v_cloud_admin oid;
  v_count integer;
BEGIN
  SELECT oid INTO v_cloud_admin FROM pg_catalog.pg_roles WHERE rolname='cloud_admin';
  IF v_cloud_admin IS NULL THEN
    RETURN;
  END IF;

  SELECT oid INTO v_worker FROM pg_catalog.pg_roles WHERE rolname='tracefab_worker';
  SELECT oid INTO v_legacy FROM pg_catalog.pg_roles WHERE rolname='tracefab_worker_legacy';
  SELECT oid INTO v_migrator FROM pg_catalog.pg_roles WHERE rolname='tracefab_migrator';
  SELECT oid INTO v_app FROM pg_catalog.pg_roles WHERE rolname='tracefab_app';

  IF v_worker IS NULL OR v_migrator IS NULL THEN
    RAISE EXCEPTION 'tracefab_neon_worker_roles_missing'
      USING HINT = 'Vérifier le provisionnement des rôles tracefab_worker et tracefab_migrator.';
  END IF;

  IF v_legacy IS NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members x
     WHERE x.member=v_migrator AND x.roleid=v_worker
       AND x.grantor=v_cloud_admin AND x.admin_option IS TRUE
       AND x.inherit_option IS FALSE AND x.set_option IS FALSE
  ) THEN
    RAISE EXCEPTION 'tracefab_worker_neon_preflight_required'
      USING HINT = 'Exécuter npm run db:preflight:worker-neon avant toute migration worker.';
  END IF;

  IF v_legacy IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_shdepend
       WHERE refobjid=v_legacy AND deptype='o'
    ) THEN
      RAISE EXCEPTION 'tracefab_worker_legacy_owns_objects';
    END IF;

    SELECT
      (SELECT count(*) FROM pg_catalog.pg_class c
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee=v_legacy)
      +
      (SELECT count(*) FROM pg_catalog.pg_proc p
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee=v_legacy)
      +
      (SELECT count(*) FROM pg_catalog.pg_namespace n
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
        WHERE a.grantee=v_legacy)
      +
      (SELECT count(*) FROM pg_catalog.pg_default_acl WHERE defaclrole=v_legacy)
      INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'tracefab_worker_legacy_acl_residuelle';
    END IF;

    IF pg_catalog.pg_has_role(v_migrator,v_worker,'MEMBER') THEN
      RAISE EXCEPTION 'tracefab_migrator_worker_membership_residuelle';
    END IF;
    IF v_app IS NOT NULL AND pg_catalog.pg_has_role(v_app,v_worker,'MEMBER') THEN
      RAISE EXCEPTION 'tracefab_app_member_of_worker';
    END IF;
  END IF;
END
$neon_worker_preflight$;
