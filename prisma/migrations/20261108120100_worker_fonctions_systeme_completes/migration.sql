-- ============================================================================
-- 20261108120100 — compléter le transfert de propriété des fonctions système
--
-- MIGRATION ADDITIVE. Aucune migration appliquée n'est réécrite.
--
-- LE DEFAUT, MESURE SUR BASE JETABLE (PostgreSQL 17.11, replay Prisma complet)
--
-- `20261028120100_worker_identity_not_forgeable` transfère SIX fonctions à
-- `tracefab_worker`. La mesure du catalogue après replay complet donne :
--
--     tracefab_upsert_clerk_user            -> tracefab_worker
--     tracefab_ensure_clerk_user            -> tracefab_worker
--     tracefab_soft_delete_clerk_user       -> tracefab_worker
--     tracefab_clerk_organization_uuid      -> tracefab_worker
--     tracefab_archive_clerk_organization   -> tracefab_worker
--     tracefab_notification_outbox_health   -> tracefab_worker
--
-- mais aussi `tracefab_sync_clerk_membership` et `tracefab_revoke_clerk_membership`
-- restées au propriétaire des migrations. Ces deux fonctions sont pourtant
-- SECURITY DEFINER et écrivent des tables en FORCE ROW LEVEL SECURITY : le
-- propriétaire des migrations est SUPERUSER sur le cluster de référence de la
-- CI, ce qui CONTOURNE la RLS et masque le défaut en test. Sur une base où le
-- propriétaire n'est pas superutilisateur, la politique
-- `(current_user = 'tracefab_worker')` ne s'ouvre pas pour elles.
--
-- POURQUOI CES DEUX FONCTIONS, ET PAS D'AUTRES
--
-- Elles sont les seules fonctions SECURITY DEFINER du domaine Clerk dont la
-- politique RLS nomme explicitement `tracefab_worker` et qui ne figurent pas
-- dans le transfert de 20261028120100. Le relevé est reproductible :
--
--     SELECT p.proname, r.rolname
--       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner ...
--      WHERE p.proname LIKE 'tracefab_%clerk%' AND p.prosecdef;
--
-- CORRECTION MESURÉE — LE TRANSFERT SEUL CASSAIT LE CHEMIN CLERK
--
--   Première version de cette migration : transfert de propriété SEUL. Mesure
--   par appel réel de `tracefab_sync_clerk_membership` sous `tracefab_app` :
--
--       CREATION d adhesion : ECHEC 42501 permission denied for table organization_memberships
--       RE-SYNCHRONISATION   : ECHEC 42501 permission denied for table organization_memberships
--
--   C'était une RÉGRESSION, et elle est instructive : ces deux fonctions ne
--   fonctionnaient que parce que leur propriétaire était SUPERUTILISATEUR et
--   contournait ainsi la RLS du cluster de référence. En déplaçant la propriété
--   vers un rôle NOBYPASSRLS, la RLS s'applique enfin — et il manquait les
--   prérequis : le worker n'avait ni INSERT sur `organization_memberships`, ni
--   politique d'écriture pour son identité.
--
--   AVANT : la fonction « marchait » en contournant un contrôle.
--   APRÈS : elle passe le contrôle, avec les droits minimaux nécessaires.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. Elle transfère la propriété des deux fonctions.
--   2. Elle pose les PRÉREQUIS du worker pour qu'elles fonctionnent réellement :
--      INSERT sur `organization_memberships` (les deux fonctions y écrivent) et
--      les politiques d'écriture `*_worker_*`, exactement selon le motif déjà
--      établi par `users_insert_worker` / `users_update_worker`.
--   3. Aucun privilège accordé à `tracefab_app` ; aucune politique existante
--      modifiée ou supprimée ; aucune donnée touchée.
--
-- CE QU'ELLE EXIGE
--
--   L'exécutant doit pouvoir endosser `tracefab_worker` : soit il en est membre
--   avec SET, soit il est SUPERUSER — c'est le cas de la CI, qui migre avec
--   `postgres`. La migration ÉCHOUE EXPLICITEMENT (fail-closed) si ce n'est pas
--   le cas, plutôt que de laisser les fonctions en place silencieusement.
--
-- REJOUABLE : `ALTER ... OWNER TO` sur un objet déjà possédé par la cible est
-- sans effet ; le contrôle préalable le constate et la migration ne fait rien.
-- ============================================================================

DO $worker_owner$
DECLARE
  -- Signatures lues au catalogue : `to_regprocedure` exige la liste d'arguments
  -- exacte, sans quoi la migration conclurait a tort que l'objet est absent.
  --   tracefab_sync_clerk_membership(TEXT, UUID, UUID, membership_role)
  --   tracefab_revoke_clerk_membership(TEXT)
  v_fonctions text[] := ARRAY[
    'public.tracefab_sync_clerk_membership(text,uuid,uuid,membership_role)',
    'public.tracefab_revoke_clerk_membership(text)'
  ];
  v_nom text;
  v_proprietaire text;
  v_deplaces int := 0;
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'tracefab_worker', 'SET')
     AND NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'worker_ownership_requires_set_role'
      USING HINT = 'Executer la chaine avec un role SUPERUSER ou membre de tracefab_worker avec SET.';
  END IF;

  -- Prerequis mesure de `ALTER ... OWNER TO` : le nouveau proprietaire doit
  -- pouvoir creer dans le schema de l'objet. Pose ici, retire juste apres la
  -- boucle. Sans lui, la chaine echoue en 42501 sur un executant non
  -- superutilisateur (voir l'en-tete).
  EXECUTE 'GRANT CREATE ON SCHEMA public TO tracefab_worker';

  FOREACH v_nom IN ARRAY v_fonctions LOOP
    SELECT r.rolname INTO v_proprietaire
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE p.oid = pg_catalog.to_regprocedure(v_nom);

    IF v_proprietaire IS NULL THEN
      RAISE EXCEPTION 'worker_ownership_target_missing: %', v_nom
        USING HINT = 'La chaine ne correspond pas a l etat attendu ; arret avant toute modification.';
    END IF;

    IF v_proprietaire = 'tracefab_worker' THEN
      CONTINUE;
    END IF;

    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO tracefab_worker', v_nom);
    v_deplaces := v_deplaces + 1;
    RAISE NOTICE 'propriete transferee au worker : %', v_nom;
  END LOOP;

  -- Le droit CREATE du worker sur `public` a servi uniquement a autoriser les
  -- transferts ci-dessus. Il est retire immediatement : le worker ne doit
  -- pouvoir creer aucun objet. Le retrait est verifie dans le bloc suivant.
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM tracefab_worker';

  -- Contrôle final : les deux fonctions appartiennent au worker, ou la
  -- migration échoue. Un transfert partiel serait pire que pas de transfert.
  IF EXISTS (
    SELECT 1
      FROM unnest(v_fonctions) AS f(nom)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(f.nom)
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE r.rolname IS DISTINCT FROM 'tracefab_worker'
  ) THEN
    RAISE EXCEPTION 'worker_ownership_incomplete';
  END IF;

  RAISE NOTICE '% fonction(s) transferee(s) ; total possede par le worker verifie', v_deplaces;
END
$worker_owner$;

-- 2. PREREQUIS D'EXECUTION DU WORKER ------------------------------------------
--
--    Les deux fonctions sont SECURITY DEFINER : leur corps s'exécute avec les
--    droits de `tracefab_worker`. Ce corps écrit `organization_memberships`
--    (création d'adhésion, réactivation, révocation). Le worker y a déjà
--    SELECT et UPDATE ; il lui manquait INSERT, et la RLS lui manquait une
--    politique d'écriture.
--
--    PORTÉE MINIMALE, MESURÉE : une seule table. Ni `organizations` ni
--    `organization_invitations` ne sont touchées par ces deux fonctions —
--    `tracefab_sync_clerk_organization`, qui écrit `organizations`, n'est pas
--    concernée par ce transfert et garde son propriétaire d'origine.
DO $worker_prerequis$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    RAISE EXCEPTION 'worker_absent'
      USING HINT = 'La chaine 20261028120100 doit avoir cree le role avant cette migration.';
  END IF;

  -- Droits de table manquants, relevés au catalogue et bornés aux deux seules
  -- tables que le corps de ces fonctions écrit réellement :
  --
  --   SELECT prosrc FROM pg_proc WHERE proname = 'tracefab_sync_clerk_membership';
  --   -> INSERT/UPDATE organization_memberships, INSERT audit_logs
  --
  -- `organization_memberships` : SELECT et UPDATE existaient, INSERT manquait.
  -- `audit_logs` : RIEN n'existait — le worker n'avait aucun accès à la piste
  -- d'audit, et ces deux fonctions y écrivent pourtant chaque synchronisation et
  -- chaque révocation. Laisser ce trou aurait signifié que le transfert de
  -- propriété SUPPRIME DES ÉCRITURES D'AUDIT : la fonction aurait échoué, ou
  -- (avec un ON CONFLICT silencieux) l'audit aurait disparu sans bruit. On
  -- accorde donc de quoi écrire l'audit, jamais de quoi le relire ni le modifier.
  EXECUTE 'GRANT INSERT ON TABLE public.organization_memberships TO tracefab_worker';
  EXECUTE 'GRANT INSERT ON TABLE public.audit_logs TO tracefab_worker';
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM tracefab_worker';

  -- Politiques d'écriture pour l'identité worker, sur le motif déjà utilisé
  -- par `users_insert_worker` : la condition porte sur `current_user`, jamais
  -- sur un GUC, donc elle n'est pas falsifiable par l'appelant. Le worker étant
  -- NOLOGIN et jamais assumable par `tracefab_app` (contrôle en fin de
  -- migration), ceci n'ouvre aucun chemin depuis l'application.
  EXECUTE 'DROP POLICY IF EXISTS organization_memberships_insert_worker ON public.organization_memberships';
  EXECUTE 'CREATE POLICY organization_memberships_insert_worker ON public.organization_memberships'
       || ' FOR INSERT TO PUBLIC WITH CHECK (CURRENT_USER = ''tracefab_worker''::name)';

  EXECUTE 'DROP POLICY IF EXISTS organization_memberships_update_worker ON public.organization_memberships';
  EXECUTE 'CREATE POLICY organization_memberships_update_worker ON public.organization_memberships'
       || ' FOR UPDATE TO PUBLIC USING (CURRENT_USER = ''tracefab_worker''::name)'
       || ' WITH CHECK (CURRENT_USER = ''tracefab_worker''::name)';

  -- Piste d'audit : INSERT pour le worker uniquement. Aucune politique de
  -- lecture, de modification ni de suppression n'est créée — la piste reste en
  -- ajout seul, et le worker ne peut pas la relire.
  EXECUTE 'DROP POLICY IF EXISTS audit_logs_insert_worker ON public.audit_logs';
  EXECUTE 'CREATE POLICY audit_logs_insert_worker ON public.audit_logs'
       || ' FOR INSERT TO PUBLIC WITH CHECK (CURRENT_USER = ''tracefab_worker''::name)';
END
$worker_prerequis$;

-- 3. CONTROLE FINAL — la regression mesuree ne peut pas revenir en silence ----
--
--    Une propriété transférée sans ses prérequis échoue seulement à l'appel :
--    le déploiement, lui, réussit. C'est exactement ce qui s'est produit. Ce
--    bloc vérifie donc les prérequis EUX-MÊMES, et fait échouer la migration.
DO $worker_prerequis_controle$
BEGIN
  IF NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.organization_memberships', 'INSERT') THEN
    RAISE EXCEPTION 'worker_prerequis_manquant: INSERT sur organization_memberships';
  END IF;

  IF NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'worker_prerequis_manquant: INSERT sur audit_logs (piste d audit)';
  END IF;

  -- L'audit reste en ajout seul : le transfert ne doit pas avoir ouvert sa
  -- relecture ni sa modification au worker.
  IF pg_catalog.has_table_privilege('tracefab_worker', 'public.audit_logs', 'UPDATE')
     OR pg_catalog.has_table_privilege('tracefab_worker', 'public.audit_logs', 'DELETE') THEN
    RAISE EXCEPTION 'audit_logs_worker_non_append_only';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'organization_memberships'
       AND policyname = 'organization_memberships_insert_worker'
  ) THEN
    RAISE EXCEPTION 'worker_prerequis_manquant: politique INSERT du worker';
  END IF;

  -- L'isolation ne doit pas avoir été rompue au passage.
  IF pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_app_member_of_worker';
  END IF;

  -- Le droit CREATE, necessaire au transfert de propriete, ne doit PAS rester :
  -- le worker est un role sans surface de creation. `20261108120200` verifie
  -- deja cet etat ; on le verifie ici pour que l'echec soit attribue a la
  -- migration qui a pose le droit.
  IF pg_catalog.has_schema_privilege('tracefab_worker', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'worker_create_sur_public_non_revoque';
  END IF;
END
$worker_prerequis_controle$;
