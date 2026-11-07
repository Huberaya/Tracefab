-- ============================================================================
-- P10.8 — 20261107120000_p108_outbox_proprietaire_et_dependances
--
-- DEPENDANCE RESOLUE, MESUREE SUR PostgreSQL 17.11 REEL
-- ---------------------------------------------------------------------------
-- #114 (tete f0aeb51, 20261106130000_identite_systeme_signee) ajoute une garde
-- `IF NOT public.tracefab_identite_systeme() ...` dans 13 operations systeme
-- SECURITY DEFINER. Deux contraintes INDEPENDANTES rendent alors ces operations
-- inexecutables si leur proprietaire reste le role de migration :
--
--   1. le predicat `tracefab_identite_systeme()` est SECURITY INVOKER et
--      #114 n'accorde son EXECUTE qu'a `tracefab_worker` (sa postcondition
--      interdit explicitement `tracefab_app` et PUBLIC). A l'interieur d'une
--      fonction SECURITY DEFINER possedee par le role de migration,
--      `current_user` vaut CE role : mesure `42501 permission denied for
--      function tracefab_identite_systeme`.
--   2. la politique RLS Forcee `notification_outbox_update_trusted` exige
--      `current_user = 'tracefab_worker'` en USING ET en WITH CHECK. Un simple
--      GRANT EXECUTE sur le predicat ne suffit donc PAS : le claim resterait a
--      0 ligne. Mesure par lecture de `pg_policies` sur PostgreSQL 17.11.
--
-- #111 (20261105235900) transfere claim/complete/enqueue_due au worker : c'est
-- la raison pour laquelle S2 reussissait et S1/S3 echouaient en P10.7. Mais
-- #111 appartient a une chaine (#110) qui RECRIT 7 migrations deja appliquees
-- sur `main` : l'integrer telle quelle est interdit. Cette migration additive
-- reprend le mecanisme, en le rendant EXHAUSTIF, IDEMPOTENT et explicite.
--
-- POURQUOI CE NOM / CET ORDRE
--   `20261107120000` est strictement posterieur a `20261106130000` (#114) et a
--   `20261106120000` (identite utilisateur). Le candidat P10.7 portait le nom
--   `20261106120300`, qui se serait applique AVANT #114 : le harnais P10.7
--   l'ajoutait manuellement en fin de liste, ordre que Prisma ne reproduit PAS.
--   Ce nom supprime l'ambiguite d'ordre (critere de cloture P10.8).
--
-- CE QUE CETTE MIGRATION FAIT
--   * transfere au worker TOUTES les operations systeme gardees par #114
--     (catalogue-driven : aucune fonction attendue n'est ignoree en silence) ;
--   * accorde au worker les privileges de table/type/fonction STRICTEMENT
--     necessaires, deja mesures par #111 ;
--   * si #114 est deja appliquee, reaffirme le GRANT du predicat au worker et
--     ferme PUBLIC ; si #114 n'est PAS encore appliquee (cette branche), elle
--     n'echeoue PAS : le transfert et les privileges sont deja en place quand
--     #114 arrivera. C'est ce qui rend la branche integrable SEULE.
--   * pose des POSTCONDITIONS qui font ECHOUER la migration explicitement.
--
-- CONDITION D'APPARTENANCE (MESUREE, PAS SUPPOSEE)
--   PostgreSQL 17.11 exige que le role qui transfere la propriete PUISSE
--   `SET ROLE tracefab_worker` (`42501 must be able to SET ROLE`) ET que le
--   role cible ait CREATE sur le schema (`42501 permission denied for schema
--   public`). En CI les migrations tournent sous le superutilisateur du service
--   jetable ; en base managee le role de migration a cree `tracefab_worker`
--   (20261028120100) et en detient donc l'ADMIN OPTION. #111 fait la meme
--   hypothese. Cette migration la VERIFIE et ECHOUE EXPLICITEMENT si elle
--   manque : elle n'accorde AUCUNE appartenance, aucune elevation automatisee.
--
-- CE QU'ELLE NE FAIT PAS
--   * aucune reecriture, aucun renommage de migration historique ;
--   * aucun GRANT a `tracefab_app` ni a PUBLIC sur l'outbox ou le predicat ;
--   * aucune desactivation de RLS, aucune modification de politique ;
--   * aucune appartenance de role accordee, aucune elevation de privileges ;
--   * aucune bascule `strict` / `systeme_strict` ;
--   * aucune lecture ni ecriture de cle HMAC, aucun secret ;
--   * aucun changement de la politique anti-rejeu P10.7.
--
-- IDEMPOTENCE : `ALTER ... OWNER TO` sur un proprietaire deja correct est un
-- no-op accepte, les GRANT sont idempotents, le droit CREATE temporaire
-- d'ALTER OWNER est revoque dans le MEME bloc (donc la meme transaction).
-- ============================================================================

DO $p108_outbox$
DECLARE
  v_worker        OID;
  v_app           OID;
  v_courant       TEXT := current_user;
  v_tmp_create    BOOLEAN := false;
  v_predicat      BOOLEAN;
  v_transferts    INTEGER := 0;
  v_manquants     TEXT;
  v_non_conf      TEXT;
  v_n             INTEGER;
  r               RECORD;
  CIBLES CONSTANT TEXT[] := ARRAY[
    'tracefab_sync_clerk_membership', 'tracefab_sync_clerk_organization',
    'tracefab_revoke_clerk_membership', 'tracefab_upsert_clerk_user',
    'tracefab_ensure_clerk_user', 'tracefab_soft_delete_clerk_user',
    'tracefab_archive_clerk_organization', 'tracefab_clerk_organization_uuid',
    'tracefab_notification_outbox_health', 'tracefab_claim_notification_outbox',
    'tracefab_complete_notification_outbox',
    'tracefab_enqueue_due_data_request_reminders',
    'tracefab_enqueue_manual_data_request_reminder'];
BEGIN
  -- 1. PRECONDITIONS ---------------------------------------------------------
  SELECT oid INTO v_worker FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker';
  IF v_worker IS NULL THEN
    RAISE EXCEPTION 'P10.8 : tracefab_worker absent — dependance non declaree';
  END IF;
  IF (SELECT rolsuper OR rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    RAISE EXCEPTION 'P10.8 : tracefab_worker ne doit pas etre superutilisateur ni BYPASSRLS';
  END IF;
  SELECT oid INTO v_app FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app';
  IF v_app IS NULL THEN
    RAISE EXCEPTION 'P10.8 : tracefab_app absent';
  END IF;
  IF pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'P10.8 : tracefab_app ne doit pas pouvoir endosser tracefab_worker';
  END IF;
  IF to_regprocedure('public.tracefab_claim_notification_outbox(integer)') IS NULL
     OR to_regprocedure('public.tracefab_complete_notification_outbox(uuid, public.tracefab_notification_status, text, text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'P10.8 : les fonctions outbox sont absentes — migration appliquee hors ordre';
  END IF;

  -- 2. PRECONDITIONS D'ALTER OWNER : AUCUNE ELEVATION ----------------------
  -- Mesure PostgreSQL 17.11 : un proprietaire NON superutilisateur ne peut
  -- transferer une fonction a `tracefab_worker` que s'il peut endosser ce
  -- role (`42501 must be able to SET ROLE`) ET si le role cible a CREATE sur
  -- le schema (`42501 permission denied for schema public`). On n'accorde
  -- JAMAIS l'appartenance : soit elle existe deja (role createur / superuser),
  -- soit la migration ECHOUE explicitement. Seul CREATE sur le schema, droit
  -- temporaire deja utilise par #111, est pose puis REVOQUE dans ce bloc.
  IF NOT pg_catalog.pg_has_role(v_courant, 'tracefab_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'P10.8 : le role de migration % ne peut pas endosser tracefab_worker (ADMIN OPTION absente). Aucune elevation automatisee : appliquer les migrations avec le role ayant cree tracefab_worker.', v_courant;
  END IF;
  IF NOT pg_catalog.has_schema_privilege('tracefab_worker', 'public', 'CREATE') THEN
    IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = v_courant)
       AND NOT pg_catalog.has_schema_privilege(v_courant, 'public', 'CREATE WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'P10.8 : droit insuffisant pour accorder temporairement CREATE sur public';
    END IF;
    EXECUTE 'GRANT CREATE ON SCHEMA public TO tracefab_worker';
    v_tmp_create := true;
  END IF;

  -- 3. TRANSFERT EXHAUSTIF DES OPERATIONS GARDEES --------------------------
  -- Catalogue-driven : toute surcharge presente est traitee, aucune liste de
  -- signatures ecrite a la main ne peut se desynchroniser.
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS f, p.proname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f','p')
       AND p.prosecdef
       AND p.proname = ANY (CIBLES)
       AND p.proowner <> v_worker
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO tracefab_worker', r.f);
    v_transferts := v_transferts + 1;
  END LOOP;

  -- 4. PRIVILEGES MINIMAUX, MESURES NECESSAIRES (identiques a #111) --------
  EXECUTE 'GRANT SELECT ON TABLE public.data_requests TO tracefab_worker';
  EXECUTE 'GRANT SELECT ON TABLE public.users TO tracefab_worker';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.tracefab_notification_outbox TO tracefab_worker';
  EXECUTE 'GRANT USAGE ON TYPE public.tracefab_notification_status TO tracefab_worker';
  EXECUTE 'GRANT USAGE ON TYPE public.tracefab_notification_event TO tracefab_worker';
  EXECUTE 'GRANT USAGE ON TYPE public.tracefab_notification_outbox TO tracefab_worker';
  EXECUTE 'GRANT USAGE ON TYPE public.membership_role TO tracefab_worker';
  IF to_regprocedure('public.tracefab_active_organization_id()') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tracefab_active_organization_id() TO tracefab_worker';
  END IF;
  IF to_regprocedure('public.tracefab_in_active_tenant(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tracefab_in_active_tenant(uuid) TO tracefab_worker';
  END IF;
  IF to_regprocedure('public.tracefab_can_access_org(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tracefab_can_access_org(uuid) TO tracefab_worker';
  END IF;

  -- 5. DEPENDANCE #114 : PRESENTE OU ABSENTE, JAMAIS SUPPOSEE --------------
  v_predicat := to_regprocedure('public.tracefab_identite_systeme()') IS NOT NULL;
  IF v_predicat THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tracefab_identite_systeme() TO tracefab_worker';
    EXECUTE 'REVOKE ALL ON FUNCTION public.tracefab_identite_systeme() FROM PUBLIC';
  ELSE
    RAISE NOTICE 'P10.8 : #114 non appliquee sur cette branche ; le transfert de propriete et les privileges worker sont neanmoins en place. Aucune dependance implicite.';
  END IF;

  -- 6. REVOCATION DU DROIT TEMPORAIRE --------------------------------------
  IF v_tmp_create THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM tracefab_worker';
  END IF;

  -- 7. POSTCONDITIONS : ECHEC EXPLICITE, JAMAIS SILENCIEUX -----------------
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_manquants
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p') AND p.prosecdef
     AND p.proname = ANY (CIBLES)
     AND (p.proowner <> v_worker OR p.proconfig IS NULL OR p.proconfig = '{}'::text[]);
  IF v_manquants IS NOT NULL THEN
    RAISE EXCEPTION 'P10.8 : operations systeme non conformes (proprietaire ou search_path) : %', v_manquants;
  END IF;

  SELECT count(*)::int INTO v_n
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p') AND p.prosecdef
     AND p.proname = ANY (CIBLES)
     AND pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P10.8 : % operation(s) systeme executable(s) par PUBLIC', v_n;
  END IF;

  IF pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_notification_outbox', 'INSERT')
     OR pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_notification_outbox', 'UPDATE') THEN
    RAISE EXCEPTION 'P10.8 : tracefab_app ne doit pas ecrire directement dans l outbox';
  END IF;
  IF NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.tracefab_notification_outbox', 'UPDATE')
     OR NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.tracefab_notification_outbox', 'SELECT') THEN
    RAISE EXCEPTION 'P10.8 : privileges worker sur l outbox incomplets';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_catalog.pg_class
           WHERE oid = 'public.tracefab_notification_outbox'::pg_catalog.regclass) THEN
    RAISE EXCEPTION 'P10.8 : RLS de l outbox desactivee ou non forcee';
  END IF;
  IF NOT pg_catalog.has_function_privilege('tracefab_app',
        'public.tracefab_claim_notification_outbox(integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('tracefab_app',
        'public.tracefab_complete_notification_outbox(uuid, public.tracefab_notification_status, text, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P10.8 : le runtime a perdu EXECUTE sur claim/complete';
  END IF;
  IF v_predicat THEN
    IF NOT pg_catalog.has_function_privilege('tracefab_worker',
          'public.tracefab_identite_systeme()', 'EXECUTE') THEN
      RAISE EXCEPTION 'P10.8 : le worker ne peut pas evaluer le predicat d identite systeme';
    END IF;
    IF pg_catalog.has_function_privilege('tracefab_app',
          'public.tracefab_identite_systeme()', 'EXECUTE') THEN
      RAISE EXCEPTION 'P10.8 : le predicat ne doit pas devenir un droit du runtime';
    END IF;
  END IF;

  RAISE NOTICE 'P10.8 : % fonction(s) transferee(s) a tracefab_worker ; predicat #114 %',
    v_transferts, CASE WHEN v_predicat THEN 'present' ELSE 'absent (branche seule)' END;
END
$p108_outbox$;
