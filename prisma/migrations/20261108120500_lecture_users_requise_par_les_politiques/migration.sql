-- ============================================================================
-- 20261108120500 — rendre lisible la table que les politiques RLS interrogent
--
-- MIGRATION ADDITIVE. Aucune migration appliquée n'est réécrite.
--
-- LE DÉFAUT, REPRODUIT PAR APPEL RÉEL SOUS `tracefab_app`
--
--     SET ROLE tracefab_app;
--     SELECT 1 FROM public.organizations LIMIT 1;
--     -> 42501 permission denied for table users
--       SQL function "tracefab_current_user_email" statement 1
--
--   et de même sur `supplier_passport_access_requests`, et sur `users`.
--
--   ANOMALIE MESURÉE : le refus ne porte pas sur la table demandée, mais sur
--   `users`. Trois lectures différentes échouent avec le MÊME message, parce
--   que leurs politiques RLS appellent `tracefab_current_user_email()`, qui
--   interroge `public.users` — table sur laquelle `tracefab_app` n'a plus
--   `SELECT`.
--
-- CAUSE EXACTE, RELEVÉE AU CATALOGUE
--
--   users -> {postgres=arwdDxtm/postgres,tracefab_worker=arw/postgres}
--
--   Aucune entrée `tracefab_app`. Or :
--
--     — `20260923130000_tracefab_neon_initial` accordait
--       `GRANT SELECT, INSERT, UPDATE ... TO PUBLIC`, **users excepté** ;
--     — `20261019120000_restreindre_dml_role_applicatif` révoque INSERT,
--       UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER — pas SELECT ;
--     — `20261028120100_worker_identity_not_forgeable` révoque à son tour
--       write sur `users` pour `tracefab_app` (déjà révoqué) ;
--     — `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES TO tracefab_app`
--       ne s'applique qu'aux tables créées APRÈS sa pose.
--
--   `users` n'a donc jamais reçu ce SELECT. Défaut PRÉEXISTANT : il est
--   identique sur `origin/main` (69 migrations), mesuré par la même sonde.
--   Il ne vient d'aucune migration de ce candidat.
--
-- POURQUOI CE N'EST PAS UN ÉLARGISSEMENT DE PRIVILÈGE
--
--   `users` est en ROW LEVEL SECURITY active ET forcée, avec pour seule
--   politique de lecture `users_select_self : (id = tracefab_current_user_id())`.
--   Accorder SELECT n'ouvre donc aucune ligne : le rôle applicatif ne peut lire
--   que sa propre identité, résolue depuis `tracefab.user_id`. C'est exactement
--   ce dont les politiques ont besoin, et rien de plus.
--
--   Aucun droit d'écriture n'est accordé : `users` reste en lecture seule pour
--   le runtime, les écritures passant par `tracefab_upsert_clerk_user` et
--   `tracefab_ensure_clerk_user`, possédées par `tracefab_worker`.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
--   — elle n'accorde aucun privilège d'écriture ;
--   — elle ne modifie, ne crée et ne supprime aucune politique RLS ;
--   — elle ne touche aucune autre table ; l'accès SELECT à `orders` est
--     accordé séparément par `20261108120600_lecture_orders_requise_par_le_runtime` ;
--     `tracefab_identity_cles` et `tracefab_runtime_function_registry` restent
--     illisibles, ce qui est voulu : le registre ne doit pas être lisible par
--     le rôle qu'il contrôle ;
--   — elle n'écrit aucune donnée.
-- ============================================================================

DO $lecture_users$
BEGIN
  -- Sans le rôle, il n'y a rien à accorder : la migration reste un no-op
  -- plutôt que d'échouer (même convention que 20261019120000).
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    RAISE NOTICE 'role tracefab_app absent : octroi de lecture sur users ignore';
    RETURN;
  END IF;

  EXECUTE 'GRANT SELECT ON TABLE public.users TO tracefab_app';

  -- Contrôle immédiat : l'octroi doit être effectif, sinon la migration échoue
  -- plutôt que de laisser trois lectures applicatives cassées en silence.
  IF NOT pg_catalog.has_table_privilege('tracefab_app', 'public.users', 'SELECT') THEN
    RAISE EXCEPTION 'lecture_users_non_effective';
  END IF;

  -- La RLS doit rester active ET forcée : accorder SELECT sur une table dont la
  -- RLS serait désactivée ouvrirait TOUTES les identités. On refuse cet état.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
     WHERE oid = 'public.users'::regclass
       AND relrowsecurity IS TRUE
       AND relforcerowsecurity IS TRUE
  ) THEN
    RAISE EXCEPTION 'users_rls_non_forcee'
      USING HINT = 'Accorder SELECT sans RLS forcee exposerait toutes les identites.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_select_self'
  ) THEN
    RAISE EXCEPTION 'users_select_self_absente'
      USING HINT = 'Sans politique de lecture, SELECT sur users ne serait borne par rien.';
  END IF;
END
$lecture_users$;
