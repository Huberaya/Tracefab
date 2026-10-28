-- ============================================================================
-- 20261028130000 — les champs calcules d'un produit ne se protegent plus par
-- un GUC falsifiable
--
-- LE DEFAUT MESURE (base jetable, 28/10/2026, role `tracefab_app` sans
-- BYPASSRLS)
--
--   `tracefab_app` detenait INSERT, UPDATE et DELETE au niveau TABLE sur
--   `tracefab_products`. Le declencheur `products_validate_brand_ownership`
--   interdit la modification des champs calcules (version, data_completion,
--   data_readiness, data_ready_at) SAUF si l'un de ces GUC vaut 'true' :
--       tracefab.internal_product_revision
--       tracefab.internal_product_readiness_update
--   Or un GUC est positionnable par n'importe quel role. Mesure :
--       UPDATE … SET version = version + 1  (sans GUC)   -> REFUS P0001
--       set_config('tracefab.internal_product_revision','true')  -> ACCEPTE
--       le meme UPDATE, GUC pose                        -> ACCEPTE (1 ligne)
--   Le role runtime pouvait donc reecrire lui-meme la version d'un produit et
--   son etat de readiness : la seule barriere etait sa bonne volonte.
--
--   C'est le meme defaut de conception que 20261028120100 (worker) et
--   20261028120200 (documents) : une autorisation qui repose sur un GUC repose
--   sur l'appelant.
--
-- CARTOGRAPHIE — cinq declencheurs gardes par un GUC, une seule table exposee
--   certifications      internal_certification_update    app(I0U0D0) protegee
--   data_request_items  internal_data_collection_update  app(I0U0D0) protegee
--   data_requests       internal_data_collection_update  app(I0U0D0) protegee
--   documents           internal_document_update         app(I0U0D0) protegee
--   tracefab_products   internal_product_revision ...    app(I1U1D1) EXPOSEE
--   Sur les quatre premieres, la barriere reelle est deja l'absence de
--   privilege d'ecriture : le GUC n'y sert a rien.
--
-- LA CORRECTION — meme forme que 20261028120200
--   Le role applicatif perd l'ecriture AU NIVEAU TABLE sur `tracefab_products`
--   et la recoit COLONNE PAR COLONNE, pour les vingt colonnes metier. Les
--   quatre colonnes calculees n'y figurent pas : elles ne sont ecrites que par
--   les fonctions SECURITY DEFINER, et le declencheur garde son drapeau interne
--   — simplement, plus aucun client ne l'atteint avec le privilege d'ecrire.
--
--   Ce n'est pas un retrait sec : l'import en masse
--   (`api/_lib/bulk-operations/bulk-importer.ts`) ecrit directement la table
--   pour les champs non calcules (name, category, sku, description, poids,
--   pays), et doit continuer de fonctionner. Le privilege colonne le preserve.
--   Un retrait total aurait exige de reecrire l'importeur — hors du perimetre
--   sur et verifiable d'une correction de securite.
--
-- VARIANTES MESUREES ET ECARTEES (toutes ecrites puis eprouvees)
--   a) declencheur DEFINER, garde `current_user = 'tracefab_app'` : n'intercepte
--      RIEN — dans un DEFINER, `current_user` vaut le proprietaire ;
--   b) declencheur INVOKER, lecture inline de `organizations` : refuse, mais
--      sort en `product_requires_brand_organization` pour une organisation
--      invisible — fait tomber test:neon:cross-tenant (« issue inclassée ») ;
--   c) declencheur INVOKER, garde `current_user = session_user` : refuse aussi
--      le seed et les scripts d'administration ;
--   d) declencheur INVOKER + aide SECURITY DEFINER : fonctionnelle, mais
--      l'aide executee par PUBLIC fait tomber l'invariant « aucune SECURITY
--      DEFINER executable par PUBLIC », et executee par `tracefab_app` elle
--      exige un GRANT EXECUTE dans une migration posterieure au registre, ce
--      que test:neon:registre-fonctions interdit par construction.
--   Aucune de ces variantes n'apportait la garantie sans casser une garantie
--   existante. Le privilege colonne, lui, ne touche ni declencheur, ni
--   politique, ni fonction.
--
-- MESURE APRES CORRECTIF (meme banc, meme role)
--   SET version                       -> REFUS 42501
--   SET version avec le GUC forge     -> REFUS 42501
--   SET name (colonne accordee)       -> ACCEPTE
--   INSERT produit                    -> ACCEPTE
--   tracefab_start_product_revision   -> ACCEPTE
--   DELETE produit                    -> REFUS 42501 (aucun appel applicatif)
--
-- CE QUE LA MIGRATION NE FAIT PAS
--   - aucune politique RLS creee, modifiee ou supprimee ; FORCE RLS inchange ;
--   - aucune fonction creee, aucun nom ajoute au registre, aucun declencheur
--     reecrit ;
--   - aucune donnee metier touchee ;
--   - aucune migration anterieure reecrite ;
--   - aucun privilege ACCORDE hors des vingt colonnes metier.
--
-- RETOUR ARRIERE
--   GRANT INSERT, UPDATE, DELETE ON TABLE public.tracefab_products
--     TO tracefab_app;
--   Le retour ramene la vulnerabilite : il n'est pas recommande.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    -- 1. Plus d'ecriture au niveau table (ni TRUNCATE, ni DELETE).
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.tracefab_products FROM tracefab_app';

    -- 2. Ecriture colonne par colonne : les vingt colonnes metier. Les champs
    --    calcules (version, data_completion, data_readiness, data_ready_at)
    --    sont volontairement absents.
    EXECUTE 'GRANT INSERT ('
         || 'id, brand_organization_id, reference, sku, name, category, status, '
         || 'public_slug, created_by, created_at, updated_at, description, '
         || 'product_family, color_name, size_range, country_of_design, '
         || 'country_of_manufacture, weight_grams, care_instructions, '
         || 'last_data_updated_by'
         || ') ON TABLE public.tracefab_products TO tracefab_app';

    EXECUTE 'GRANT UPDATE ('
         || 'id, brand_organization_id, reference, sku, name, category, status, '
         || 'public_slug, created_by, created_at, updated_at, description, '
         || 'product_family, color_name, size_range, country_of_design, '
         || 'country_of_manufacture, weight_grams, care_instructions, '
         || 'last_data_updated_by'
         || ') ON TABLE public.tracefab_products TO tracefab_app';
  END IF;
END $$;

COMMENT ON COLUMN public.tracefab_products.version IS
  'Champ calcule. Ecriture reservee aux fonctions SECURITY DEFINER : le role applicatif ne detient que des privileges colonne, qui excluent ce champ.';
