-- P10.7 — un SECURITY DEFINER doit pouvoir appeler les helpers qu'il emploie.
--
-- LE DEFAUT MESURE (2026-11-12)
--
-- 20261105235900_active_tenant_policy_and_worker_closure a transfere
-- `public.tracefab_current_user_email()` a `tracefab_worker`, en retirant
-- EXECUTE a PUBLIC et en le rendant SECURITY DEFINER :
--
--     REVOKE ALL ON FUNCTION public.tracefab_current_user_email() FROM PUBLIC;
--     GRANT EXECUTE ON FUNCTION public.tracefab_current_user_email() TO tracefab_app;
--     ALTER DEFAULT PRIVILEGES FOR ROLE tracefab_worker IN SCHEMA public
--       REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--
-- Le GRANT vise `tracefab_app` — le role qui APPELLE les fonctions. Mais le
-- corps d'une fonction SECURITY DEFINER s'execute avec les privileges de son
-- PROPRIETAIRE : `tracefab_migrator`. Or `tracefab_migrator` n'a jamais recu
-- EXECUTE sur ce helper. Toute fonction definer, proprietaire tracefab_migrator,
-- qui appelle `tracefab_current_user_email()` echoue donc en :
--
--     42501 permission denied for function tracefab_current_user_email
--
-- Deux fonctions sont dans ce cas :
--
--     tracefab_accept_organization_invitation   (RSVP d'invitation fournisseur)
--     tracefab_register_supplier_organization   (auto-onboarding fournisseur)
--
-- sur 52 fonctions SECURITY DEFINER appelant un helper d'identite (51
-- proprietaire tracefab_migrator, 1 proprietaire tracefab_worker) : les 50
-- autres appellent `tracefab_current_user_id()`, dont `tracefab_migrator` est
-- proprietaire et detient donc EXECUTE implicitement.
--
-- POURQUOI CE N'EST PAS UNE FAILLE
--
-- Le helper reste inaccessible a PUBLIC et a tout role non liste ; il est
-- SECURITY INVOKER-borne par sa propre politique de ligne (users_select_self).
-- On n'elargit EXECUTE qu'au proprietaire des fonctions qui en dependent :
-- c'est le privilege minimal qui rend le chemin existant executable. Aucune
-- politique, aucun corps de fonction, aucune donnee n'est modifiee ici.
--
-- PREUVE (controle negatif permanent, scripts/test_p107_grants_helpers.mjs) :
-- avant = echec reproduit pour les deux fonctions, apres = succes ; retirer de
-- nouveau le GRANT fait RE-apparaitre le 42501. Un correctif sans controle
-- negatif ne prouve rien.

BEGIN;

DO $grants_helpers_entre_definer$
DECLARE
  v_migrator oid;
  v_helper oid;
  v_once bigint;
BEGIN
  SELECT oid INTO v_migrator FROM pg_roles WHERE rolname = 'tracefab_migrator';
  SELECT p.oid INTO v_helper
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_current_user_email'
     AND pg_get_function_identity_arguments(p.oid) = '';

  -- Sans le role de migration, il n'y a rien a accorder : la migration reste
  -- un no-op plutot que d'echouer. C'est le cas d'une base ou le bootstrap n'a
  -- pas encore tourne — et c'est la convention du depot, posee par
  -- 20261019120000_restreindre_dml_role_applicatif pour la meme raison. Les
  -- bancs qui rejouent la chaine sur PGlite (moteur WASM, aucun role cree)
  -- doivent pouvoir la traverser : `test:diagnostic-m6` mesure le schema, pas
  -- les roles.
  IF v_migrator IS NULL THEN
    RAISE NOTICE 'role tracefab_migrator absent : octroi du helper ignore';
    RETURN;
  END IF;
  IF v_helper IS NULL THEN
    RAISE EXCEPTION 'grants_helpers_definer_helper_missing: tracefab_current_user_email() absent';
  END IF;

  -- Idempotent : `GRANT` l'est deja, la verification ci-dessous le mesure
  -- plutot que de le supposer.
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.tracefab_current_user_email() TO %I',
                 'tracefab_migrator');

  IF NOT pg_catalog.has_function_privilege(v_migrator, v_helper, 'EXECUTE') THEN
    RAISE EXCEPTION 'grants_helpers_definer_not_effective: tracefab_migrator ne peut pas executer tracefab_current_user_email';
  END IF;

  -- Le GRANT est refait a chaque execution (base neuve comme base deja
  -- migree) : la migration est idempotente et ne depend pas d'un etat
  -- anterieur. Trace pour la lecture des journaux de deploiement.
  RAISE NOTICE 'grants helpers definer : EXECUTE accorde a tracefab_migrator sur tracefab_current_user_email()';

  -- Post-condition : PUBLIC reste ferme. C'est l'etat que la migration du
  -- 20261105 avait etabli et que celle-ci ne doit pas defaire.
  SELECT count(*) INTO v_once
    FROM pg_catalog.aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_helper),
                                        pg_catalog.acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_helper)))) a
   WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE';
  IF v_once <> 0 THEN
    RAISE EXCEPTION 'grants_helpers_definer_opened_public';
  END IF;
END
$grants_helpers_entre_definer$;

COMMIT;
