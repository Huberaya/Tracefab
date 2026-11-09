-- ============================================================================
-- 20261108120600 — rendre lisible une table que le schéma expose et que RLS borne
--
-- MIGRATION ADDITIVE. Aucune migration appliquée n'est réécrite.
--
-- LE DÉFAUT, MESURÉ
--
-- `scripts/lire-disponibilite-role-app.mjs` — le contrôle que le dépôt exécute
-- AVANT toute bascule du runtime — refuse la cible :
--
--     OBSTACLE : SELECT absent sur orders
--     VERDICT : 1 obstacle(s) avant bascule
--
--   Relevé au catalogue : `orders` existe, RLS active ET forcée, trois
--   politiques en place (`orders_select_participant`, `orders_insert_buyer`,
--   `orders_update_participant`), et `tracefab_app` n'a ni SELECT, ni INSERT,
--   ni UPDATE, ni DELETE.
--
-- CAUSE EXACTE
--
--   `20260923130000_tracefab_neon_initial` crée `orders` et lui pose ses
--   politiques, mais NE L'INCLUT PAS dans le `GRANT SELECT, INSERT, UPDATE ...
--   TO PUBLIC` du § 12 : la liste de ce GRANT s'arrête à `audit_logs`.
--   `20261014130000_revoke_public_schema_privileges` ne peut donc transférer à
--   `tracefab_app` qu'un privilège qui n'existe pas. `ALTER DEFAULT PRIVILEGES
--   ... GRANT SELECT` de `20261019120000` ne s'applique qu'aux tables futures.
--
--   `orders` est ainsi restée lisible par son seul propriétaire. Les politiques
--   RLS qui la protègent n'ont jamais pu s'exercer pour le runtime : elles
--   n'ont servi à rien. Défaut PRÉEXISTANT, identique sur `origin/main`.
--
-- POURQUOI SELECT, ET SEULEMENT SELECT
--
--   Le contrôle nomme exactement `SELECT absent`, et les politiques de lecture
--   existent déjà. En revanche AUCUN chemin d'écriture `orders` n'existe dans
--   `api/` (relevé : zéro occurrence, ni méthode de modèle Prisma, ni SQL) et
--   `orders` ne figure pas dans `TABLES_ECRITURE_DIRECTE`. Accorder INSERT ou
--   UPDATE créerait donc un droit que rien n'utilise — exactement ce que
--   `test_privileges_role_app.mjs` est là pour empêcher.
--
--   La lecture est bornée par RLS, active et forcée :
--     buyer_user_id = tracefab_current_user_id()
--     OR (organization_id IS NOT NULL AND tracefab_is_org_member(organization_id))
--   soit : l'acheteur, ou un membre de l'organisation concernée. Rien d'autre.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
--   — aucun droit d'écriture ; aucune politique modifiée, créée ou supprimée ;
--   — aucune donnée touchée ; aucun autre objet accordé.
-- ============================================================================

DO $lecture_orders$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    RAISE NOTICE 'role tracefab_app absent : octroi de lecture sur orders ignore';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = 'public.orders'::regclass) THEN
    RAISE EXCEPTION 'orders_absente'
      USING HINT = 'La chaine 20260923130000 doit avoir cree la table avant cette migration.';
  END IF;

  EXECUTE 'GRANT SELECT ON TABLE public.orders TO tracefab_app';

  IF NOT pg_catalog.has_table_privilege('tracefab_app', 'public.orders', 'SELECT') THEN
    RAISE EXCEPTION 'lecture_orders_non_effective';
  END IF;

  -- La RLS doit rester active ET forcée : accorder SELECT sur une table dont la
  -- RLS serait désactivée ouvrirait toutes les commandes de toutes les
  -- organisations. On refuse cet état plutôt que de le laisser passer.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
     WHERE oid = 'public.orders'::regclass
       AND relrowsecurity IS TRUE
       AND relforcerowsecurity IS TRUE
  ) THEN
    RAISE EXCEPTION 'orders_rls_non_forcee'
      USING HINT = 'Accorder SELECT sans RLS forcee exposerait toutes les commandes.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'orders' AND policyname = 'orders_select_participant'
  ) THEN
    RAISE EXCEPTION 'orders_select_participant_absente'
      USING HINT = 'Sans politique de lecture, SELECT sur orders ne serait borne par rien.';
  END IF;
END
$lecture_orders$;
