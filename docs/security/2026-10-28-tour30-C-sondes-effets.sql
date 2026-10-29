-- TRACEFAB — sondes d'EFFET, LECTURE SEULE.
--
-- POURQUOI CETTE SONDE EXISTE
--
-- L'historique Prisma de production ne connait pas onze migrations du depot.
-- Deux d'entre elles y figurent comme ANNULEES (`rolled_back_at` renseigne) :
-- un `migrate resolve --rolled-back` a efface leur trace sans rien defaire.
-- Onze lignes d'historique ne disent donc pas onze effets absents — elles
-- disent qu'on ne sait pas.
--
-- Cette lecture ne demande rien a l'historique : elle interroge le CATALOGUE et
-- deux tables de reference, et mesure l'etat reel des objets que ces migrations
-- sont censees laisser derriere elles.
--
-- Aucune ecriture, aucun appel de fonction applicative, aucune ligne metier
-- lue a part le libelle d'un profil de referentiel.
--
--   Sortie : une ligne par sonde, champs separes par `|`.
--   S|migration|sonde|valeur
--
-- A coller dans le SQL Editor de Neon, branche `Primary`.

WITH f AS (
  SELECT p.proname, pg_catalog.pg_get_functiondef(p.oid) AS def
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
),
t AS (
  SELECT c.relname, c.oid
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v')
)
SELECT ligne FROM (
  -- 1. `publication_explicite` : `tracefab_product_is_public` doit exiger une
  --    revue (`reviewed_at`) et non plus un simple `readiness_status`.
  SELECT 1 AS o, 'S|20261010120000|product_is_public_posee|'
         || coalesce((SELECT 'oui' FROM f WHERE proname = 'tracefab_product_is_public'), 'non')
         || '|exige_revue|'
         || coalesce((SELECT (def LIKE '%reviewed_at%')::text FROM f WHERE proname = 'tracefab_product_is_public'), 'non') AS ligne

  UNION ALL
  -- 2. `active_tenant_context` : trois fonctions, dont la garde.
  SELECT 2, 'S|20261017120000|fonctions_tenant|'
         || (SELECT count(*)::text FROM f WHERE proname IN (
               'tracefab_active_organization_id',
               'tracefab_in_active_tenant',
               'tracefab_require_active_tenant'))
         || '|attendu|3'

  UNION ALL
  -- 3. `dpp_readiness_truthful_gates` : le referentiel doit dire « technique ».
  SELECT 3, 'S|20261021170000|libelle_profil_dpp|'
         || coalesce((SELECT name FROM public.dpp_requirement_profiles ORDER BY name LIMIT 1), '(aucun)')

  UNION ALL
  -- 4. `dpp_quality_gate_requires_assessment` : la porte exige une evaluation.
  -- La migration exige une EVALUATION persistee en plus de l'absence d'anomalie
  -- ouverte. Attention : `data_quality_scores` apparait DEJA dans la version
  -- precedente (branche `quality.no_blocking_issues`). Chercher le nom de la
  -- table ne distingue donc rien — essaye, et mesure comme muet. Le marqueur
  -- utile est la LECTURE PAR PRODUIT, propre a la nouvelle branche.
  SELECT 4, 'S|20261027100000|requirement_met_lit_scores_du_produit|'
         || coalesce((SELECT (def LIKE '%FROM data_quality_scores s WHERE s.product_id = p_product_id%')::text
                        FROM f WHERE proname = 'tracefab_dpp_requirement_met'), 'non')

  UNION ALL
  -- 5. `dpp_review_preservation_and_publication_coherence`.
  SELECT 5, 'S|20261027130000|suspend_nonconforming_posee|'
         || coalesce((SELECT 'oui' FROM f WHERE proname = 'tracefab_suspend_nonconforming_publication'), 'non')

  UNION ALL
  -- 6. `runtime_function_registry` : la table de registre doit exister.
  SELECT 6, 'S|20261028120000|table_registre|'
         || coalesce((SELECT 'oui' FROM t WHERE relname = 'tracefab_runtime_function_registry'), 'non')

  UNION ALL
  -- 7. `worker_identity_not_forgeable` : le role dedie et les politiques qui
  --    le nomment. C'est le coeur de la migration : un role absent signifie
  --    que les politiques reposent encore sur un GUC falsifiable.
  SELECT 7, 'S|20261028120100|role_tracefab_worker|'
         || coalesce((SELECT 'oui' FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker'), 'non')
         || '|politiques_sur_current_user|'
         || (SELECT count(*)::text FROM pg_catalog.pg_policies
              WHERE schemaname = 'public'
                -- `strpos` ET NON `LIKE`, pour la raison qui a produit un faux
                -- positif ailleurs dans ce chantier : dans un motif LIKE, `_`
                -- est un JOKER. `LIKE '%tracefab_worker%'` matche donc
                -- `'tracefab.worker_context'` — l'ANCIENNE forme, celle que la
                -- migration doit avoir remplacee. Cette sonde exigeait aussi
                -- `current_user`, ce qui la sauvait ; elle ne doit pas dependre
                -- de cette coincidence.
                --
                -- ET `lower()` N'EST PAS DECORATIF : `pg_policies.qual` rend le
                -- mot-cle en MAJUSCULES (`CURRENT_USER = 'tracefab_worker'`).
                -- Un `strpos` sensible a la casse ne trouvait qu'UNE politique
                -- sur onze, et faisait echouer la calibration. Mesure : 24
                -- politiques mentionnent current_user en ILIKE, 11 en
                -- strpos(lower(...)). Les deux doivent s'accorder.
                AND (strpos(pg_catalog.lower(coalesce(qual, '')), 'current_user') > 0
                  OR strpos(pg_catalog.lower(coalesce(with_check, '')), 'current_user') > 0)
                AND (strpos(pg_catalog.lower(coalesce(qual, '')), 'tracefab_worker') > 0
                  OR strpos(pg_catalog.lower(coalesce(with_check, '')), 'tracefab_worker') > 0))

  UNION ALL
  -- 8. `document_reserved_fields_internal_only`.
  SELECT 8, 'S|20261028120200|mark_document_scanning_posee|'
         || coalesce((SELECT 'oui' FROM f WHERE proname = 'tracefab_mark_document_scanning'), 'non')
         || '|update_app_sur_documents|'
         || coalesce((SELECT pg_catalog.has_table_privilege('tracefab_app', 'public.documents', 'UPDATE')::text), 'role absent')

  UNION ALL
  -- 9. `product_computed_fields_column_scoped`. Le declencheur doit avoir
  --    cesse de lire le GUC, et le role runtime ne doit plus ecrire la table.
  SELECT 9, 'S|20261028130000|update_app_sur_tracefab_products|'
         || coalesce((SELECT pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_products', 'UPDATE')::text), 'role absent')
         || '|trigger_lit_encore_le_guc|'
         || coalesce((
              SELECT (pg_catalog.pg_get_triggerdef(tg.oid) LIKE '%internal_product_revision%')::text
                FROM pg_catalog.pg_trigger tg
               WHERE tg.tgrelid = 'public.tracefab_products'::regclass
                 AND NOT tg.tgisinternal
                 AND tg.tgname = 'products_validate_brand_ownership'), 'trigger absent')

  UNION ALL
  -- 10. `supplier_invitation_owner_relationship_scope`.
  SELECT 10, 'S|20261028140000|garde_relation_invitation|'
         || coalesce((SELECT (def LIKE '%invitation_relationship_organization_mismatch%')::text
                        FROM f WHERE proname = 'tracefab_validate_member_invitation_role'), 'fonction absente')

  UNION ALL
  -- 11. `plm_erp_policy_convergence` : deja mesuree, rappelee ici pour que la
  --     sonde se lise seule.
  SELECT 11, 'S|20261028150000|politiques_plm_erp_sync_jobs|'
         || (SELECT count(*)::text FROM pg_catalog.pg_policies
              WHERE schemaname = 'public' AND tablename = 'plm_erp_sync_jobs')
         || '|attendu|2'
) x
ORDER BY o, ligne;
