-- TraceFab — deux tables que le runtime DOIT pouvoir lire, et qui ne l'etaient pas.
--
-- LE DEFAUT, MESURE
--
-- Sur une base migree, connecte en `tracefab_app` :
--
--     select has_table_privilege('tracefab_app','public.users','SELECT');            -- false
--     select has_table_privilege('tracefab_app',
--              'public.tracefab_runtime_function_registry','SELECT');                -- false
--
-- Or le depot lui-meme documente l'intention inverse :
--
--   - `public.users` porte une politique `users_select_self`
--     (`id = tracefab_current_user_id()`) : une politique de LECTURE n'a de sens
--     que si le role peut lire ;
--   - `scripts/lire-disponibilite-role-app.mjs` declare
--     `tracefab_runtime_function_registry` « lisible par conception : le runtime
--     doit pouvoir constater son propre perimetre ».
--
-- Consequence : `test:neon:rls` classe ces deux tables parmi les « erreurs de
-- politique » (42501) — la RLS n'est jamais evaluee puisque l'ACL refuse avant.
-- Une politique qu'on ne peut pas atteindre ne protege rien et ne prouve rien.
--
-- CE QUE LA MIGRATION ACCORDE, ET CE QU'ELLE N'ACCORDE PAS
--
-- Seulement SELECT, sur deux tables, et sous les politiques DEJA en place :
--
--   users                             -> `users_select_self` : la ligne de
--                                        l'identite courante, jamais celle d'un
--                                        tiers ; `users_worker_select` pour
--                                        l'identite worker.
--   tracefab_runtime_function_registry -> lecture du perimetre declare, aucune
--                                        ecriture (la politique proprietaire
--                                        n'ouvre l'ecriture qu'au proprietaire
--                                        de la table).
--
-- `orders` reste ferme : aucune route, aucun appel Prisma ne la lit, et sa
-- politique n'autorise que le participant. Elle est desormais classee
-- « fermee par conception » dans `scripts/lib/tracefab_app_role.mjs`, avec la
-- justification mesuree (aucune surface runtime), au lieu d'apparaitre comme
-- une erreur de politique dans un test.
--
-- Aucun INSERT/UPDATE/DELETE n'est accorde. Les postconditions le verifient.

BEGIN;

GRANT SELECT ON TABLE public.users TO tracefab_app;
GRANT SELECT ON TABLE public.tracefab_runtime_function_registry TO tracefab_app;

DO $postconditions$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['users', 'tracefab_runtime_function_registry'] LOOP
    IF NOT pg_catalog.has_table_privilege('tracefab_app', format('public.%I', v_table), 'SELECT') THEN
      RAISE EXCEPTION 'runtime_read_grant_missing: %', v_table;
    END IF;
    IF pg_catalog.has_table_privilege('tracefab_app', format('public.%I', v_table), 'INSERT')
       OR pg_catalog.has_table_privilege('tracefab_app', format('public.%I', v_table), 'UPDATE')
       OR pg_catalog.has_table_privilege('tracefab_app', format('public.%I', v_table), 'DELETE')
       OR pg_catalog.has_table_privilege('tracefab_app', format('public.%I', v_table), 'TRUNCATE') THEN
      RAISE EXCEPTION 'runtime_write_grant_unexpected: %', v_table;
    END IF;
    -- La RLS doit rester active ET forcee : un GRANT sans politique serait une
    -- ouverture, pas un correctif.
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_table
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'runtime_read_grant_without_forced_rls: %', v_table;
    END IF;
  END LOOP;

  -- Une politique de LECTURE doit exister sur chacune : sans elle, FORCE RLS
  -- avec zero politique de SELECT rend toutes les lignes invisibles.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
     WHERE p.polname = 'users_select_self' AND p.polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'runtime_read_grant_missing_select_policy: users';
  END IF;

  -- NOTE — `orders` n'est volontairement pas verifiee ici.
  --
  -- Sur une base amorcee par `db:seed-rls`, le runtime recoit un SELECT filtre
  -- par RLS sur l'ensemble des tables de donnees, `orders` comprise (politique
  -- `orders_select_participant`). Une postcondition « orders reste fermee »
  -- ferait donc echouer la chaine dans l'environnement de reference pour une
  -- raison qui appartient au provisionnement, pas au depot.
END;
$postconditions$;

COMMIT;
