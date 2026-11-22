-- ============================================================================
-- 20261108120300 — les ACL colonne ne survivent plus à une révocation de table
--
-- MIGRATION ADDITIVE. Aucune migration appliquée n'est réécrite.
--
-- LE DEFAUT, MESURE DEUX FOIS
--
-- Sur une base VIERGE, la chaîne de `origin/main` produit ZÉRO ACL colonne pour
-- `tracefab_app`, et le `REVOKE ... ON TABLE` de `20261028120200` et
-- `20261028130000` suffit. Mesure reproducible : replay Prisma complet, puis
-- `sondes/mesurer-acl-colonnes.mjs` -> « aucun écart mesuré ».
--
-- Sur une base DERIVEE (base Neon existante, où des `GRANT UPDATE (colonnes)`
-- ont été émis par des outils antérieurs), les ACL COLONNE survivent au
-- `REVOKE` table-level. PostgreSQL les traite comme deux jeux de droits
-- distincts. Mesure : après avoir reposé les ACL héritées
-- (`--avec-acl-heritees`), `tracefab_app` peut écrire
--
--     documents.status, byte_size, sha256, uploaded_by, available_at,
--     deleted_at, deleted_by
--     tracefab_products.version, data_completion, data_readiness, data_ready_at
--
-- soit exactement les champs que `20261028120200` et `20261028130000`
-- prétendent fermer. Le `REVOKE` table-level ne les ferme pas.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. Elle liste, dans le CATALOGUE, les ACL colonne accordées au rôle
--      applicatif — pas une liste écrite à la main, qui se désynchroniserait.
--   2. Elle les RÉVOQUE.
--   3. Elle REPOSE le périmètre métier exact du runtime, et seulement lui.
--
-- LE PÉRIMÈTRE REPOSÉ N'EST PAS CHOISI, IL EST RELEVÉ
--
-- `scripts/../sondes/relever-ecritures-runtime.mjs` lit les 5 appels
-- `prisma.tracefab_products.{update,updateMany,create}` de `api/` et rend les
-- colonnes réellement écrites par le runtime :
--
--     name, category, status, sku, description, updated_at,
--     weight_grams, country_of_manufacture, country_of_design
--
-- Neuf colonnes, ni plus ni moins. Les quatre champs calculés
-- (`version`, `data_completion`, `data_readiness`, `data_ready_at`) et les
-- champs d'identité (`id`, `created_at`, `reference`,
-- `brand_organization_id`, `created_by`) restent hors de portée directe : ils
-- passent par les fonctions SECURITY DEFINER.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
--   — elle ne touche à AUCUNE ACL de `documents` : `tracefab_app` n'y a plus
--     aucun droit d'écriture depuis `20261028120200`, et retirer des ACL
--     colonne sur une table où il n'a pas de droit de table ne changerait rien.
--     Le contrôle final le vérifie plutôt que de le supposer.
--   — elle n'accorde aucun droit nouveau hors du périmètre ci-dessus ;
--   — elle n'écrit pas dans `_prisma_migrations` ; aucune donnée métier.
--
-- REJOUABLE : les `REVOKE` sont sans effet si l'ACL est déjà absente, et les
-- `GRANT` reposent le même état.
-- ============================================================================

DO $tf_acl_colonnes$
DECLARE
  v_app_oid oid;
  v_columns text;
  r record;
BEGIN
  SELECT oid INTO v_app_oid FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app';
  IF v_app_oid IS NULL THEN
    RAISE EXCEPTION 'tracefab_app_absent'
      USING HINT = 'La chaine exige le role applicatif avant cette migration.';
  END IF;

  -- 1. Toute ACL colonne accordée au rôle applicatif est retirée. On part du
  --    catalogue : une colonne ajoutée plus tard par une autre migration ne
  --    peut pas être oubliée ici.
  FOR r IN
    SELECT c.relname AS table_name, a.attname AS colonne
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
     WHERE n.nspname = 'public'
       AND acl.grantee = v_app_oid
       AND a.attacl IS NOT NULL
     GROUP BY c.relname, a.attname
     ORDER BY c.relname, a.attname
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE public.%I FROM tracefab_app',
      r.colonne, r.table_name
    );
  END LOOP;

  -- 2. Le périmètre du runtime est reposé, colonne par colonne.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'tracefab_products') THEN

    SELECT string_agg(pg_catalog.format('%I', a.attname), ', ' ORDER BY a.attnum)
      INTO v_columns
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.tracefab_products'::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attname IN ('name', 'category', 'status', 'sku', 'description',
                         'updated_at', 'weight_grams', 'country_of_manufacture',
                         'country_of_design');

    IF v_columns IS NULL OR array_length(string_to_array(v_columns, ','), 1) <> 9 THEN
      RAISE EXCEPTION 'perimetre_runtime_incomplet: %', coalesce(v_columns, 'aucune colonne')
        USING HINT = 'Le schema ne correspond pas a l etat attendu ; arret avant tout GRANT.';
    END IF;

    EXECUTE pg_catalog.format(
      'GRANT UPDATE (%s) ON TABLE public.tracefab_products TO tracefab_app', v_columns);
    EXECUTE pg_catalog.format(
      'GRANT INSERT (%s) ON TABLE public.tracefab_products TO tracefab_app', v_columns);
  END IF;

  -- 3. Contrôles finaux : l'état accordé est exactement celui mesuré, et aucun
  --    champ sensible n'est atteignable en écriture directe.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
     WHERE n.nspname = 'public'
       AND acl.grantee = v_app_oid
       -- `status` est légitimement inscriptible sur le PRODUIT (le runtime le
       -- fait) mais JAMAIS sur un DOCUMENT (il vaut approbation de fichier).
       AND acl.privilege_type IN ('INSERT', 'UPDATE')
       AND (
            (c.relname = 'tracefab_products'
             AND a.attname IN ('version', 'data_completion', 'data_readiness', 'data_ready_at'))
         OR (c.relname = 'documents'
             AND a.attname IN ('status', 'byte_size', 'sha256', 'uploaded_by',
                               'available_at', 'deleted_at', 'deleted_by'))
       )
  ) THEN
    RAISE EXCEPTION 'acl_colonne_sensible_restante'
      USING HINT = 'Un champ gere par le pipeline reste modifiable directement ; la migration echoue plutot que de laisser croire a une fermeture.';
  END IF;
END
$tf_acl_colonnes$;
