-- ============================================================================
-- CANDIDAT P10.7 — 20261106120300_outbox_owner_identite_systeme
--
-- POURQUOI CE CORRECTIF EXISTE
-- ---------------------------------------------------------------------------
-- Mesure du 2026-11-06 sur PostgreSQL jetable, avec le proprietaire des
-- fonctions outbox modelise par un role NON superutilisateur (forme des roles
-- d'administration Neon) et une VERITABLE connexion applicative
-- (`SET SESSION AUTHORIZATION tracefab_app`) :
--
--   * chaine `main` + #114 (20261105120000_identite_systeme_signee) :
--       claim  -> 42501 permission denied for function tracefab_identite_systeme
--       complete -> non atteint ; sans jeton -> meme 42501 (message trompeur)
--   * chaine `main` + #111 + #114 :
--       claim  -> 1 ligne, status=processing, attempts=1
--       complete -> sent
--       sans jeton -> 42501 authentication_required
--
-- CAUSE MESUREE, pas supposee : #114 rend `tracefab_claim_notification_outbox`
-- et `tracefab_complete_notification_outbox` dependantes du predicat
-- `public.tracefab_identite_systeme()` (SECURITY INVOKER). Ce predicat n'est
-- accorde qu'a `tracefab_worker`. Or sur `main`, ces DEUX fonctions restent
-- possedees par le role de migration : `20261028120100_worker_identity_not_forgeable`
-- ne transfere que six autres fonctions, pas claim/complete. Le corps
-- SECURITY DEFINER s'execute donc avec les droits du proprietaire, qui n'a pas
-- EXECUTE sur le predicat. #111 (20261105235900) transfere precisement ces deux
-- fonctions a `tracefab_worker` et accorde au worker les DML necessaires.
--
-- #114 N'EST DONC PAS AUTONOME : elle depend de #111, ou d'un equivalent.
-- #111 appartient a une chaine (#110) qui RECRIT 7 migrations deja appliquees
-- sur `main` : l'integrer telle quelle est interdit. Ce correctif reprend le
-- STRICT MINIMUM de #111, sous forme d'une migration ADDITIVE, sans toucher
-- a aucune migration historique, sans elargir les droits du runtime.
--
-- CE QU'IL NE FAIT PAS
--   * aucun renommage ni reecriture de migration appliquee ;
--   * aucun GRANT a `tracefab_app` (le runtime ne peut toujours pas ecrire
--     directement dans l'outbox) ;
--   * aucun GRANT a PUBLIC ;
--   * aucune desactivation de RLS, aucune modification de politique ;
--   * aucune bascule de `strict` ou de `systeme_strict` ;
--   * aucune lecture ni ecriture de cle HMAC.
--
-- PRECONDITION : #114 deja appliquee. Sinon la migration ECHOUE explicitement.
-- RETOUR ARRIERE : `ALTER FUNCTION ... OWNER TO <proprietaire precedent>` par
-- le proprietaire, ou retour a la revision precedente de la branche candidate.
-- ============================================================================

DO $p107_outbox$
DECLARE
  v_claim   REGPROCEDURE;
  v_complete REGPROCEDURE;
  v_worker  OID;
BEGIN
  IF to_regprocedure('public.tracefab_identite_systeme()') IS NULL THEN
    RAISE EXCEPTION 'P10.7 : identite systeme absente — correctif applique hors ordre (apres #114 requis)';
  END IF;

  SELECT oid INTO v_worker FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker';
  IF v_worker IS NULL THEN
    RAISE EXCEPTION 'P10.7 : tracefab_worker absent';
  END IF;

  IF pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'P10.7 : tracefab_app ne doit pas etre membre de tracefab_worker';
  END IF;

  v_claim    := 'public.tracefab_claim_notification_outbox(integer)'::pg_catalog.regprocedure;
  v_complete := 'public.tracefab_complete_notification_outbox(uuid, public.tracefab_notification_status, text, text, timestamptz)'::pg_catalog.regprocedure;

  -- Transfert minimal des DEUX fonctions gardees par #114. Les ACL existantes
  -- sont conservees ; CREATE OR REPLACE ulterieur preservegalement le proprietaire.
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO tracefab_worker', v_claim);
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO tracefab_worker', v_complete);

  -- Droits strictement necessaires au worker sur la table outbox (identiques a
  -- #111), sans jamais donner d'ecriture directe au runtime.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.tracefab_notification_outbox TO tracefab_worker';
  EXECUTE 'GRANT USAGE ON TYPE public.tracefab_notification_status TO tracefab_worker';
  EXECUTE 'GRANT USAGE ON TYPE public.tracefab_notification_event TO tracefab_worker';
  EXECUTE 'GRANT USAGE ON TYPE public.tracefab_notification_outbox TO tracefab_worker';
  -- Le predicat doit rester un droit du WORKER uniquement (postcondition de #114).
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.tracefab_identite_systeme() TO tracefab_worker';
  EXECUTE 'REVOKE ALL ON FUNCTION public.tracefab_identite_systeme() FROM PUBLIC';

  -- POSTCONDITIONS : une fonction non protegee fait ECHOUER la migration
  -- explicitement, au lieu d'etre ignoree silencieusement.
  IF (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_claim) <> v_worker
     OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_complete) <> v_worker THEN
    RAISE EXCEPTION 'P10.7 : transfert de propriete outbox incomplet';
  END IF;
  IF NOT pg_catalog.has_function_privilege('tracefab_worker',
       'public.tracefab_identite_systeme()', 'EXECUTE') THEN
    RAISE EXCEPTION 'P10.7 : le worker ne peut pas evaluer le predicat d identite systeme';
  END IF;
  IF pg_catalog.has_function_privilege('tracefab_app',
       'public.tracefab_identite_systeme()', 'EXECUTE') THEN
    RAISE EXCEPTION 'P10.7 : le predicat ne doit pas devenir un droit du runtime';
  END IF;
  IF pg_catalog.has_table_privilege('tracefab_app',
       'public.tracefab_notification_outbox', 'INSERT')
     OR pg_catalog.has_table_privilege('tracefab_app',
       'public.tracefab_notification_outbox', 'UPDATE') THEN
    RAISE EXCEPTION 'P10.7 : le runtime ne doit pas ecrire directement dans l outbox';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(
      coalesce((SELECT p.proacl FROM pg_catalog.pg_proc p
                 WHERE p.oid = 'public.tracefab_identite_systeme()'::pg_catalog.regprocedure),
               pg_catalog.acldefault('f', (SELECT p.proowner FROM pg_catalog.pg_proc p
                 WHERE p.oid = 'public.tracefab_identite_systeme()'::pg_catalog.regprocedure)))) a
     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'P10.7 : le predicat est executable par PUBLIC';
  END IF;
END
$p107_outbox$;
