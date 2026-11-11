-- ============================================================================
-- 20261108120200 — appartenance worker bornée et propriété des objets existants
--
-- MIGRATION ADDITIVE. Aucune migration appliquée n'est réécrite.
--
-- DEUX DEFAUTS MESURES, DEUX CORRECTIONS SÉPARÉES
--
-- 1. APPARENANCE RÉSIDUELLE
--    `20261028120100`, § 6, accorde `tracefab_worker` au rôle exécutant pour
--    pouvoir transférer la propriété, puis § 6 bis la révoque. Sur la chaîne de
--    `origin/main`, exécutée par `postgres` (superutilisateur), la révocation
--    est REFUSÉE par PostgreSQL : `2BP01 dependent privileges exist` — parce
--    que le même grantor a accordé `tracefab_worker` à un autre rôle. Résultat
--    mesuré : l'appartenance reste, et `postgres` peut endosser
--    `tracefab_worker` en permanence.
--
--    Sur un rôle de migration NON superutilisateur, le défaut est l'inverse et
--    il est bloquant : ce rôle ne peut pas endosser `tracefab_worker`, donc
--    `20261028120200` échoue ensuite en `42501 permission denied for function`.
--    C'est documenté dans `scripts/lib/migrations_assistees.mjs`, qui traite
--    cette migration comme « assistée ».
--
--    LA CORRECTION EST BORNEE DANS LA MIGRATION : elle accorde à current_user
--    `INHERIT TRUE, SET TRUE, ADMIN FALSE` au début de sa transaction, vérifie
--    les options, puis révoque avant COMMIT. Aucun GRANT ne reste ouvert entre
--    migrations et aucun runner externe n'est nécessaire sur Neon.
--    `tracefab_app` ne devient jamais membre de `tracefab_worker`.
--
-- 2. OBJETS EXISTANTS NON TRANSFERES
--    `20261028120100` transfère six fonctions NOMMÉES. Sur une base où des
--    objets du domaine Clerk existent sous un autre propriétaire (cas d'une
--    base migrée par un outil antérieur), ce transfert laisse des objets
--    derrière lui. Comportement attendu en cas d'anomalie : la migration
--    ÉCHOUE, elle ne répare pas en silence.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
--   — elle n'accorde rien à `tracefab_app` (aucun privilège, aucune
--     appartenance) ;
--   — elle ne modifie aucune politique RLS ;
--   — elle ne crée ni ne supprime aucun rôle ; elle accorde puis révoque
--     uniquement l'appartenance temporaire de current_user à tracefab_worker ;
--   — elle n'écrit pas dans `_prisma_migrations`.
-- ============================================================================

-- 1. Appartenance worker : elle doit provenir du runner, temporairement ------
DO $worker_membership$
DECLARE
  v_superuser boolean;
  v_peut_set boolean;
  v_inherit boolean;
  v_set boolean;
  v_admin boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    RAISE EXCEPTION 'tracefab_worker_absent'
      USING HINT = 'La chaine 20261028120100 doit avoir cree le role avant cette migration.';
  END IF;

  SELECT rolsuper INTO v_superuser
    FROM pg_catalog.pg_roles WHERE rolname = current_user;

  IF v_superuser IS DISTINCT FROM TRUE
     AND NOT pg_catalog.pg_has_role(current_user, 'tracefab_worker', 'SET') THEN
    EXECUTE pg_catalog.format(
      'GRANT tracefab_worker TO %I WITH SET TRUE, INHERIT TRUE, ADMIN FALSE',
      current_user
    );
  END IF;

  SELECT pg_catalog.pg_has_role(current_user, 'tracefab_worker', 'SET'),
         (SELECT bool_and(m.inherit_option) FROM pg_catalog.pg_auth_members m
           JOIN pg_catalog.pg_roles cible ON cible.oid = m.roleid
           JOIN pg_catalog.pg_roles membre ON membre.oid = m.member
          WHERE cible.rolname = 'tracefab_worker' AND membre.rolname = current_user),
         (SELECT bool_and(m.set_option) FROM pg_catalog.pg_auth_members m
           JOIN pg_catalog.pg_roles cible ON cible.oid = m.roleid
           JOIN pg_catalog.pg_roles membre ON membre.oid = m.member
          WHERE cible.rolname = 'tracefab_worker' AND membre.rolname = current_user),
         (SELECT COALESCE(bool_or(m.admin_option), false) FROM pg_catalog.pg_auth_members m
           JOIN pg_catalog.pg_roles cible ON cible.oid = m.roleid
           JOIN pg_catalog.pg_roles membre ON membre.oid = m.member
          WHERE cible.rolname = 'tracefab_worker' AND membre.rolname = current_user)
    INTO v_peut_set, v_inherit, v_set, v_admin;

  -- Sur Neon, current_user dispose de CREATEROLE. Si le runner a déjà
  -- accordé l'appartenance temporaire, elle est vérifiée ; sinon la migration
  -- la crée elle-même. Dans les deux cas, elle est révoquée avant COMMIT.
  IF v_superuser IS DISTINCT FROM TRUE THEN
    IF v_peut_set IS DISTINCT FROM TRUE OR v_inherit IS DISTINCT FROM TRUE
       OR v_set IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'worker_membership_temporaire_absente_ou_incomplete'
        USING HINT = 'Le runner doit accorder une appartenance directe INHERIT/SET temporaire avant cette migration.';
    END IF;
    IF v_admin IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'worker_membership_admin_forbidden'
        USING HINT = 'L appartenance temporaire ne doit jamais porter ADMIN OPTION.';
    END IF;
  END IF;
END
$worker_membership$;

-- 2. Contrôles d'isolation : l'application ne doit jamais endosser le worker --
DO $worker_isolation$
BEGIN
  IF pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_app_member_of_worker'
      USING HINT = 'Isolation rompue : le role applicatif peut endosser l identite systeme.';
  END IF;

  -- Le worker ne doit pouvoir créer aucun objet dans public.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles r
      JOIN pg_catalog.pg_namespace n ON n.nspname = 'public'
     WHERE r.rolname = 'tracefab_worker'
       AND pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE')
  ) THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM tracefab_worker';
    RAISE NOTICE 'CREATE sur public retire a tracefab_worker';
  END IF;
END
$worker_isolation$;
-- 3. L'appartenance temporaire est retirée avant COMMIT -----------------------
DO $worker_membership_revoke$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member
    JOIN pg_catalog.pg_roles w ON w.oid = m.roleid
    WHERE r.rolname = current_user AND w.rolname = 'tracefab_worker'
  ) THEN
    EXECUTE pg_catalog.format('REVOKE tracefab_worker FROM %I', current_user);
  END IF;
END
$worker_membership_revoke$;
