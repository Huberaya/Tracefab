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
--    LA CORRECTION ICI EST BORNÉE ET MESURÉE : elle accorde au rôle de
--    migration l'appartenance minimale `INHERIT TRUE, SET TRUE, ADMIN FALSE`
--    — jamais ADMIN — et laisse la révocation de § 6 bis faire son travail
--    quand elle le peut. Elle n'élargit aucun droit à `tracefab_app`, qui
--    n'est jamais membre de `tracefab_worker` (contrôle final ci-dessous).
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
--   — elle ne crée, ne supprime et ne révoque aucun rôle ;
--   — elle n'écrit pas dans `_prisma_migrations`.
-- ============================================================================

-- 1. Appartenance worker bornée, sans ADMIN ----------------------------------
DO $worker_membership$
DECLARE
  v_sans_admin boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    RAISE EXCEPTION 'tracefab_worker_absent'
      USING HINT = 'La chaine 20261028120100 doit avoir cree le role avant cette migration.';
  END IF;

  -- Une appartenance avec ADMIN donnée par un rôle privilégié existe déjà en
  -- production (octroi bootstrap du fournisseur) : elle est CONSERVÉE, car la
  -- retirer demanderait les droits du grantor. On vérifie seulement qu'elle
  -- n'a pas été accordée par nous avec ADMIN.
  SELECT NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles cible ON cible.oid = m.roleid
      JOIN pg_catalog.pg_roles membre ON membre.oid = m.member
     WHERE cible.rolname = 'tracefab_worker'
       AND membre.rolname = current_user
       AND m.admin_option IS TRUE
  ) INTO v_sans_admin;

  IF NOT v_sans_admin THEN
    RAISE EXCEPTION 'worker_membership_admin_forbidden'
      USING HINT = 'Une appartenance ADMIN a tracefab_worker a ete accordee a ce role ; elle doit etre revue par un administrateur.';
  END IF;

  IF NOT pg_catalog.pg_has_role(current_user, 'tracefab_worker', 'SET') THEN
    EXECUTE pg_catalog.format(
      'GRANT tracefab_worker TO %I WITH INHERIT TRUE, SET TRUE, ADMIN FALSE',
      current_user
    );
    RAISE NOTICE 'appartenance worker (INHERIT, SET, sans ADMIN) accordee au role executant';
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
