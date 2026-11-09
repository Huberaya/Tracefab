-- ============================================================================
-- 20261108120000 — ingestion PLM/ERP compatible avec le graphe versionne
--
-- MIGRATION ADDITIVE. Elle ne modifie AUCUNE migration deja appliquee : elle
-- redefinit la fonction `tracefab_ingest_plm_erp_payload` avec `CREATE OR
-- REPLACE`, exactement comme une correction « forward » doit le faire.
--
-- POURQUOI ELLE EXISTE — et pourquoi elle n'est PAS dans la migration
-- d'origine
--
-- La chaine de `origin/main` (commit 788df220) est appliquee en Production et
-- en Preproduction : l'instantané Neon du 04/11 relève 56 migrations
-- terminees, dont `20261030140000_ingest_payload_role_guard_and_acl`. Son
-- empreinte y est figee. Reecrire ce fichier changerait son SHA-256 et ferait
-- echouer `prisma migrate deploy` avec `P3008 modified after being applied`
-- (documente par la PR #110 elle-meme, qui a du « restaurer » deux empreintes).
--
-- LE DEFAUT, MESURE SUR BASE JETABLE (PostgreSQL 17.11, replay Prisma complet)
--
--   `product_materials` n'a qu'une contrainte unique sur
--   (product_id, material_id, material_role, product_version). L'`ON CONFLICT`
--   de la version d'origine vise seulement `(product_id, material_id)` :
--
--       ERROR 42P10: there is no unique or exclusion constraint matching the
--                    ON CONFLICT specification
--
--   Conséquence : TOUT appel réel de l'ingestion qui déclare une composition
--   echoue en 42P10. Le défaut n'apparait pas au replay — la chaîne s'applique
--   parce que le corps de la fonction n'est pas exécuté — il apparait au
--   premier import PLM. C'est la définition d'un défaut latent.
--
--   La même version insère dans `supply_chain_nodes` des colonnes que la table
--   n'a pas (`country_code`) et un `created_by` absent : l'ingestion des étapes
--   de fabrication échoue également. `tracefab_create_supply_chain_node` et
--   `tracefab_add_supply_chain_link` sont les points d'entrée officiels de ce
--   graphe versionné ; les contourner en écrivant les tables directement est ce
--   qui a produit le défaut.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   1. Elle conserve la garde de rôle de session (SECURITY DEFINER + rôle
--      applicatif ou propriétaire), `search_path` épinglé, et la purge d'ACL de
--      la version d'origine : ces propriétés sont correctes et ne bougent pas.
--   2. Elle aligne l'ingestion sur le graphe versionné : `version` du produit
--      est lue puis reportée sur `product_materials.product_version`,
--      `ON CONFLICT` vise la clé réellement unique, et les étapes passent par
--      `tracefab_create_supply_chain_node` et
--      `tracefab_add_supply_chain_link`, les points d'entrée officiels du graphe.
--      Le second exigeait `20261108120400` (typage ENUM) : la dépendance est
--      explicite et vérifiée par appel réel, pas supposée.
--   3. Elle rend le graphe IDEMPOTENT : une étape déjà présente n'est pas
--      recréée, et un lien déjà présent n'est pas réinséré. Les deux fonctions
--      officielles insèrent toujours ; c'est leur contrat, pas un défaut. Le
--      contrôle appartient donc à l'ingestion. Mesure : deux ingestions
--      identiques produisaient 4 nœuds et 2 liens pour 2 étapes.
--   4. Elle n'accorde AUCUN privilège : le droit du rôle applicatif reste régi
--      par le registre runtime (20261021120000), comme le contrôle C de
--      `scripts/test_registre_fonctions_runtime.mjs` l'exige.
--
-- CE QU'ELLE NE FAIT PAS
--
--   — elle ne modifie aucune migration historique, ni son empreinte ;
--   — elle n'écrit pas dans `_prisma_migrations` ;
--   — elle ne touche aucune donnée métier et ne crée aucun secret ;
--   — elle n'élargit aucun privilège.
--
-- REJOUABLE : `CREATE OR REPLACE` + `COMMENT` sont idempotents.
-- ============================================================================

CREATE OR REPLACE FUNCTION tracefab_ingest_plm_erp_payload(
  p_organization_id UUID,
  p_system_type TEXT,
  p_payload JSONB,
  p_integration_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id UUID := tracefab_current_user_id();
  v_role_autorise BOOLEAN;
  v_org_type organization_type;
  v_products JSONB;
  v_prod JSONB;
  v_product_id UUID;
  v_product_version INT := 1;
  v_is_new_product BOOLEAN;
  v_ref TEXT;
  v_name TEXT;
  v_sku TEXT;
  v_category TEXT;
  v_description TEXT;
  v_color TEXT;
  v_country_mfg VARCHAR(2);
  v_weight NUMERIC(10,2);
  v_gtin TEXT;
  v_materials JSONB;
  v_mat JSONB;
  v_mat_id UUID;
  v_mat_name TEXT;
  v_mat_type TEXT;
  v_mat_origin VARCHAR(2);
  v_mat_composition JSONB;
  v_mat_pct NUMERIC(7,4);
  v_mat_role TEXT;
  v_steps JSONB;
  v_step JSONB;
  v_step_label TEXT;
  v_step_process TEXT;
  v_step_country VARCHAR(2);
  v_node_id UUID;
  v_prev_node_id UUID;
  
  v_count_records INT := 0;
  v_count_created INT := 0;
  v_count_updated INT := 0;
  v_count_materials INT := 0;
  v_count_identifiers INT := 0;
  v_count_nodes INT := 0;
  v_job_id UUID;
  v_summary TEXT;
BEGIN
  -- P10.2 — AUTORISATION TECHNIQUE NON FALSIFIABLE.
  --
  -- L identite applicative NE PEUT PAS reposer sur un GUC : `tracefab.user_id`
  -- est positionnable par quiconque detient une connexion (`SET`, ou
  -- `set_config`), et cette fonction s execute en SECURITY DEFINER — donc avec
  -- les droits de son proprietaire. Un GUC n est donc jamais une preuve.
  --
  -- Le seul element que le client ne peut pas fabriquer est le ROLE DE SESSION,
  -- authentifie par PostgreSQL. `session_user` est un MOT-CLE SQL, pas une
  -- fonction : il ne peut pas etre detourne par le search_path, et il n a donc
  -- pas a etre qualifie (l ecrire `pg_catalog.session_user` est une erreur de
  -- syntaxe — mesure du 30/10). L execution est reservee au role applicatif.
  -- Un superutilisateur reste admis : il a deja l acces direct aux tables, le
  -- refuser ici ne protegerait rien.
  SELECT r.rolsuper INTO v_role_autorise
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = session_user;
  IF NOT COALESCE(v_role_autorise, false) THEN
    v_role_autorise := (pg_catalog.to_regrole('tracefab_app') IS NOT NULL)
      AND pg_catalog.pg_has_role(session_user, 'tracefab_app', 'MEMBER');
  END IF;
  -- 3) LE PROPRIETAIRE DE LA FONCTION (P10.3).
  --
  -- Mesure Neon du 04/11 sur Production ET Préproduction :
  --   - neondb_owner : NOSUPERUSER, BYPASSRLS, propriétaire de la fonction,
  --     et membre de tracefab_app (pg_has_role = true) ;
  --   - tracefab_app : NOSUPERUSER, NOBYPASSRLS, membre de lui-même, mais
  --     PAS membre de neondb_owner ;
  --   - une session tracefab_app a été observée en Production.
  --
  -- Le propriétaire passe donc aujourd'hui par la première branche
  -- pg_has_role(session_user, 'tracefab_app', 'MEMBER'). La branche propriétaire
  -- ci-dessous reste un fallback explicite pour une configuration où le rôle
  -- propriétaire ne serait pas membre de tracefab_app. Elle ne permet jamais
  -- à tracefab_app d'endosser neondb_owner. Le contrôle prosecdef empêche que
  -- cette branche survive à un passage en SECURITY INVOKER, où « propriétaire »
  -- et « appelant » se confondraient.
  IF NOT COALESCE(v_role_autorise, false) THEN
    SELECT true INTO v_role_autorise
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'tracefab_ingest_plm_erp_payload'
       AND p.prosecdef
       AND pg_catalog.pg_get_userbyid(p.proowner) = session_user
     LIMIT 1;
    v_role_autorise := COALESCE(v_role_autorise, false);
  END IF;
  IF NOT COALESCE(v_role_autorise, false) THEN
    RAISE EXCEPTION 'ingest_role_not_allowed'
      USING HINT = 'tracefab_ingest_plm_erp_payload est reserve au role applicatif tracefab_app ou au proprietaire de la fonction.';
  END IF;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  SELECT type INTO v_org_type
  FROM organizations
  WHERE id = p_organization_id;

  IF v_org_type IS DISTINCT FROM 'brand'::organization_type THEN
    RAISE EXCEPTION 'brand_organization_required';
  END IF;

  IF jsonb_typeof(p_payload) = 'array' THEN
    v_products := p_payload;
  ELSIF p_payload ? 'styles' AND jsonb_typeof(p_payload->'styles') = 'array' THEN
    v_products := p_payload->'styles';
  ELSIF p_payload ? 'articles' AND jsonb_typeof(p_payload->'articles') = 'array' THEN
    v_products := p_payload->'articles';
  ELSIF p_payload ? 'products' AND jsonb_typeof(p_payload->'products') = 'array' THEN
    v_products := p_payload->'products';
  ELSIF p_payload ? 'articleMaster' THEN
    v_products := jsonb_build_array(p_payload->'articleMaster');
  ELSE
    v_products := jsonb_build_array(p_payload);
  END IF;

  FOR v_prod IN SELECT * FROM jsonb_array_elements(v_products)
  LOOP
    v_count_records := v_count_records + 1;
    v_ref := COALESCE(
      v_prod->>'reference',
      v_prod->>'styleNumber',
      v_prod->>'code',
      v_prod->>'MATNR',
      v_prod->>'sku',
      'REF-' || lpad(v_count_records::text, 4, '0')
    );
    v_name := COALESCE(
      v_prod->>'name',
      v_prod->>'styleName',
      v_prod->>'title',
      v_prod->>'MAKTX',
      'Article ' || v_ref
    );
    v_sku := NULLIF(COALESCE(v_prod->>'sku', v_prod->>'MATNR', v_ref), '');
    v_category := NULLIF(COALESCE(v_prod->>'category', v_prod->>'department', v_prod->>'MATKL', 'Apparel'), '');
    v_description := NULLIF(COALESCE(v_prod->>'description', v_prod->>'season', ''), '');
    v_color := NULLIF(COALESCE(v_prod->>'color_name', v_prod->>'colorway', v_prod->>'color', ''), '');
    v_country_mfg := NULLIF(COALESCE(v_prod->>'country_of_manufacture', v_prod->>'countryOfManufacture', v_prod->>'madeIn', v_prod->>'HERKL', ''), '');
    IF v_country_mfg IS NOT NULL AND length(v_country_mfg) > 2 THEN
      v_country_mfg := substring(v_country_mfg from 1 for 2);
    END IF;
    
    v_weight := NULLIF(COALESCE(v_prod->>'weight_grams', v_prod->>'weightGrams', v_prod->>'netWeight', v_prod->>'BRGEW', ''), '')::numeric;

    SELECT id, version INTO v_product_id, v_product_version
    FROM tracefab_products
    WHERE brand_organization_id = p_organization_id AND reference = v_ref;

    IF v_product_id IS NOT NULL THEN
      v_is_new_product := false;
      UPDATE tracefab_products
      SET name = v_name,
          sku = COALESCE(v_sku, sku),
          category = COALESCE(v_category, category),
          description = COALESCE(v_description, description),
          color_name = COALESCE(v_color, color_name),
          country_of_manufacture = COALESCE(v_country_mfg, country_of_manufacture),
          weight_grams = COALESCE(v_weight, weight_grams),
          updated_at = now(),
          last_data_updated_by = v_user_id
      WHERE id = v_product_id;
      v_count_updated := v_count_updated + 1;
    ELSE
      v_is_new_product := true;
      v_product_version := 1;
      INSERT INTO tracefab_products (
        brand_organization_id,
        reference,
        name,
        sku,
        category,
        description,
        color_name,
        country_of_manufacture,
        weight_grams,
        version,
        created_by,
        last_data_updated_by
      ) VALUES (
        p_organization_id,
        v_ref,
        v_name,
        v_sku,
        v_category,
        v_description,
        v_color,
        v_country_mfg,
        v_weight,
        v_product_version,
        v_user_id,
        v_user_id
      )
      RETURNING id INTO v_product_id;
      v_count_created := v_count_created + 1;
    END IF;

    -- Upsert GTIN identifier
    v_gtin := COALESCE(v_prod->>'gtin', v_prod->>'ean', v_prod->>'ean13', v_prod->>'EAN11');
    IF v_gtin IS NOT NULL AND length(trim(v_gtin)) > 0 THEN
      INSERT INTO product_identifiers (
        product_id,
        identifier_type,
        identifier_value,
        is_primary,
        created_by
      ) VALUES (
        v_product_id,
        'gtin',
        trim(v_gtin),
        true,
        v_user_id
      )
      ON CONFLICT (product_id, identifier_type, identifier_value)
      DO UPDATE SET is_primary = true;
      v_count_identifiers := v_count_identifiers + 1;
    END IF;

    -- Ingest Materials / BOM
    IF v_prod ? 'materials' AND jsonb_typeof(v_prod->'materials') = 'array' THEN
      v_materials := v_prod->'materials';
    ELSIF v_prod ? 'bom' AND jsonb_typeof(v_prod->'bom') = 'array' THEN
      v_materials := v_prod->'bom';
    ELSIF v_prod ? 'BOM' AND jsonb_typeof(v_prod->'BOM') = 'array' THEN
      v_materials := v_prod->'BOM';
    ELSE
      v_materials := '[]'::jsonb;
    END IF;

    FOR v_mat IN SELECT * FROM jsonb_array_elements(v_materials)
    LOOP
      v_mat_name := COALESCE(v_mat->>'materialName', v_mat->>'name', v_mat->>'POSTX', 'Matière textile');
      v_mat_type := COALESCE(v_mat->>'materialType', v_mat->>'type', 'fabric');
      v_mat_origin := NULLIF(COALESCE(v_mat->>'originCountryCode', v_mat->>'country', v_mat->>'origin', ''), '');
      IF v_mat_origin IS NOT NULL AND length(v_mat_origin) > 2 THEN
        v_mat_origin := substring(v_mat_origin from 1 for 2);
      END IF;
      v_mat_composition := COALESCE(v_mat->'composition', '{}'::jsonb);
      v_mat_pct := COALESCE(
        NULLIF(v_mat->>'percentage', '')::numeric,
        NULLIF(v_mat->>'ratio', '')::numeric,
        NULLIF(v_mat->>'MENGE', '')::numeric,
        100.0
      );
      v_mat_role := COALESCE(v_mat->>'role', 'main');

      SELECT id INTO v_mat_id
      FROM materials
      WHERE owner_organization_id = p_organization_id AND name = v_mat_name;

      IF v_mat_id IS NULL THEN
        INSERT INTO materials (
          owner_organization_id,
          name,
          material_type,
          origin_country_code,
          composition,
          created_by
        ) VALUES (
          p_organization_id,
          v_mat_name,
          v_mat_type,
          v_mat_origin,
          v_mat_composition,
          v_user_id
        )
        RETURNING id INTO v_mat_id;
        v_count_materials := v_count_materials + 1;
      END IF;

      INSERT INTO product_materials (
        product_id,
        material_id,
        material_role,
        product_version,
        percentage,
        unit
      ) VALUES (
        v_product_id,
        v_mat_id,
        v_mat_role,
        v_product_version,
        v_mat_pct,
        '%'
      )
      ON CONFLICT (product_id, material_id, material_role, product_version)
      DO UPDATE SET
        percentage = EXCLUDED.percentage;
    END LOOP;

    -- Ingest production steps / supply chain nodes
    IF v_prod ? 'productionSteps' AND jsonb_typeof(v_prod->'productionSteps') = 'array' THEN
      v_steps := v_prod->'productionSteps';
    ELSIF v_prod ? 'supplyChainSteps' AND jsonb_typeof(v_prod->'supplyChainSteps') = 'array' THEN
      v_steps := v_prod->'supplyChainSteps';
    ELSE
      v_steps := '[]'::jsonb;
    END IF;

    v_prev_node_id := NULL;
    FOR v_step IN SELECT * FROM jsonb_array_elements(v_steps)
    LOOP
      v_step_label := COALESCE(v_step->>'label', v_step->>'step', 'Étape de fabrication');
      v_step_process := COALESCE(v_step->>'step', v_step->>'processCode', 'assembly');
      v_step_country := NULLIF(COALESCE(v_step->>'country', v_step->>'countryCode', ''), '');
      IF v_step_country IS NOT NULL AND length(v_step_country) > 2 THEN
        v_step_country := substring(v_step_country from 1 for 2);
      END IF;

      -- IDEMPOTENCE DU GRAPHE.
      --
      -- `tracefab_create_supply_chain_node` INSERE toujours un noeud : l'appeler
      -- a chaque ingestion duplique l'etape a chaque passage. Mesure : deux
      -- ingestions identiques produisaient 4 noeuds et 2 liens pour 2 etapes.
      -- Ce defaut existait deja AVANT cette migration (il etait masque par le
      -- 42804 qui empechait tout appel d'aboutir).
      --
      -- La fonction officielle reste utilisee pour CREER le noeud — elle porte
      -- les controles de role, d'acces et de coherence du graphe. Elle n'est
      -- simplement pas rappelee pour une etape deja presente, identifiee par
      -- (produit du graphe, code de procede, libelle) — c'est la cle naturelle
      -- que le declencheur `tracefab_validate_supply_chain_node` impose deja
      -- (exactement une reference non nulle, ici le code de procede).
      SELECT id INTO v_node_id
        FROM supply_chain_nodes
       WHERE graph_product_id = v_product_id
         AND node_type = 'process'
         AND process_code = v_step_process
         AND label = v_step_label;

      IF v_node_id IS NULL THEN
        SELECT id INTO v_node_id
        FROM tracefab_create_supply_chain_node(
          v_product_id,
          'process'::node_type,
          v_step_label,
          NULL::uuid,
          NULL::uuid,
          NULL::uuid,
          NULL::uuid,
          v_step_process,
          jsonb_build_object('country_code', v_step_country),
          NULL::uuid,
          CURRENT_DATE
        );
        v_count_nodes := v_count_nodes + 1;
      END IF;

      IF v_prev_node_id IS NOT NULL
         AND v_prev_node_id <> v_node_id
         -- IDEMPOTENCE DU LIEN. `tracefab_add_supply_chain_link` INSERE
         -- toujours : sans ce controle, chaque ingestion ajoute un lien
         -- identique. Mesure : deux ingestions identiques produisaient 2 liens
         -- pour une seule arete logique. On ne cree le lien que s'il n'existe
         -- pas deja pour cette arete et ce type.
         AND NOT EXISTS (
           SELECT 1 FROM supply_chain_links
            WHERE product_id = v_product_id
              AND source_node_id = v_prev_node_id
              AND target_node_id = v_node_id
              AND link_type = 'next_step'
         ) THEN
        -- Appel a la FONCTION OFFICIELLE du graphe versionne.
        --
        -- Elle pose elle-meme `status` ('declared' sans preuve documentaire),
        -- `declared_by`, et fait passer le lien par le declencheur
        -- `tracefab_validate_supply_chain_link` : existence des noeuds, absence
        -- d'auto-reference, coherence du produit, acces au document de preuve.
        -- Ecrire la table directement contournait ces controles.
        --
        -- PREREQUIS : `20261108120400_lien_graphe_statut_enum_type`, qui type le
        -- `CASE` de la fonction. Sans elle, l'appel echoue en 42804. L'ordre des
        -- migrations le garantit (…8120400 est posterieure), et la sonde
        -- `sondes/sonde-ingestion-plm.mjs` le verifie par appel reel.
        PERFORM public.tracefab_add_supply_chain_link(
          v_product_id,
          v_prev_node_id,
          v_node_id,
          'next_step'::supply_chain_link_type,
          v_count_nodes,
          CURRENT_DATE,
          NULL::date,
          NULL::uuid,
          '{}'::jsonb
        );
      END IF;

      v_prev_node_id := v_node_id;
    END LOOP;

    PERFORM tracefab_refresh_product_data_readiness(v_product_id);
  END LOOP;

  v_summary := format('Ingestion %s réussie : %s articles traités (%s créés, %s mis à jour), %s matières rattachées, %s GTINs indexés, %s nœuds traçabilité ajoutés.',
    p_system_type, v_count_records, v_count_created, v_count_updated, v_count_materials, v_count_identifiers, v_count_nodes);

  INSERT INTO plm_erp_sync_jobs (
    integration_id,
    brand_organization_id,
    source_system,
    job_reference,
    status,
    total_records,
    products_created,
    products_updated,
    materials_created,
    nodes_created,
    warnings,
    payload_preview,
    created_by
  ) VALUES (
    p_integration_id,
    p_organization_id,
    p_system_type,
    'SYNC-' || upper(p_system_type) || '-' || floor(extract(epoch from now()) * 1000)::text,
    'completed',
    v_count_records,
    v_count_created,
    v_count_updated,
    v_count_materials,
    v_count_nodes,
    '[]'::jsonb,
    jsonb_build_object('summary', v_summary, 'sample_count', v_count_records, 'system_type', p_system_type),
    v_user_id
  )
  RETURNING id INTO v_job_id;

  IF p_integration_id IS NOT NULL THEN
    UPDATE plm_erp_integrations
    SET last_sync_at = now(),
        sync_count = sync_count + 1,
        status = 'active',
        updated_at = now()
    WHERE id = p_integration_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'jobId', v_job_id,
    'systemType', p_system_type,
    'recordsIngested', v_count_records,
    'productsCreated', v_count_created,
    'productsUpdated', v_count_updated,
    'materialsCreated', v_count_materials,
    'identifiersCreated', v_count_identifiers,
    'nodesCreated', v_count_nodes,
    'summary', v_summary
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- ACL : plus aucune execution hors du role applicatif.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.tracefab_ingest_plm_erp_payload(UUID, TEXT, JSONB, UUID) FROM PUBLIC;

-- Un GRANT explicite a un role nomme survivrait au REVOKE ... FROM PUBLIC.
-- On retire donc EXECUTE a tout role qui le detient sans y avoir droit, en
-- conservant le proprietaire et le role applicatif. Aucun GRANT n est emis ici :
-- voir l en-tete.
DO $acl_ingest$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role_name
      FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
     WHERE p.oid = 'public.tracefab_ingest_plm_erp_payload(uuid,text,jsonb,uuid)'::regprocedure
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> 0
       AND a.grantee::regrole::text NOT IN ('tracefab_app', pg_catalog.pg_get_userbyid(p.proowner))
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION public.tracefab_ingest_plm_erp_payload(UUID, TEXT, JSONB, UUID) FROM %I',
      r.role_name
    );
  END LOOP;
END
$acl_ingest$;

-- ----------------------------------------------------------------------------
-- 1 bis. `tracefab_create_supply_chain_node` : le meme CASE non type
--
-- L'ingestion passe par ce point d'entree officiel. Il porte un `CASE` de
-- litteraux non type affecte a une colonne ENUM : 42804 a l'execution.
-- Le corps est celui de `20261020120000`, a une difference pres — le type du
-- `CASE`. Rien d'autre n'est modifie.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_create_supply_chain_node(
  p_graph_product_id UUID, p_node_type node_type, p_label TEXT,
  p_organization_id UUID DEFAULT NULL, p_supplier_site_id UUID DEFAULT NULL,
  p_product_id UUID DEFAULT NULL, p_material_id UUID DEFAULT NULL,
  p_process_code TEXT DEFAULT NULL, p_metadata JSONB DEFAULT '{}'::jsonb,
  p_source_document_id UUID DEFAULT NULL, p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_product tracefab_products; v_node supply_chain_nodes;
  v_site_owner UUID; v_material_owner UUID;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_graph_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'traceability_product_not_found'; END IF;
  IF NOT tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner','admin','manager','contributor']::membership_role[])
    THEN RAISE EXCEPTION 'traceability_brand_role_required'; END IF;
  IF length(trim(COALESCE(p_label, ''))) = 0 THEN RAISE EXCEPTION 'traceability_node_label_required'; END IF;
  IF p_node_type = 'product' AND p_product_id IS DISTINCT FROM p_graph_product_id
    THEN RAISE EXCEPTION 'traceability_product_node_must_match_graph_product'; END IF;

  IF p_node_type = 'material' THEN
    SELECT owner_organization_id INTO v_material_owner FROM materials WHERE id = p_material_id;
    IF v_material_owner IS NULL OR NOT (tracefab_can_access_org(v_material_owner)
      OR tracefab_can_access_shared_subject(v_material_owner, 'material', p_material_id))
      THEN RAISE EXCEPTION 'traceability_material_access_denied'; END IF;
  END IF;
  IF p_node_type = 'site' THEN
    SELECT s.organization_id INTO v_site_owner FROM supplier_sites ss JOIN suppliers s ON s.id = ss.supplier_id WHERE ss.id = p_supplier_site_id;
    IF v_site_owner IS NULL OR NOT (tracefab_can_access_org(v_site_owner)
      OR tracefab_can_access_shared_subject(v_site_owner, 'supplier_site', p_supplier_site_id))
      THEN RAISE EXCEPTION 'traceability_site_access_denied'; END IF;
  END IF;
  IF p_node_type = 'organization' AND p_organization_id IS DISTINCT FROM v_product.brand_organization_id
    AND NOT EXISTS (SELECT 1 FROM brand_supplier_relationships r WHERE r.brand_organization_id = v_product.brand_organization_id
      AND r.supplier_organization_id = p_organization_id AND r.status = 'active')
    THEN RAISE EXCEPTION 'traceability_organization_not_in_active_relationship'; END IF;

  INSERT INTO supply_chain_nodes (
    graph_product_id, node_type, organization_id, supplier_site_id, product_id,
    material_id, process_code, label, metadata, status, source_document_id,
    declared_by, observed_at
  ) VALUES (
    p_graph_product_id, p_node_type, p_organization_id, p_supplier_site_id, p_product_id,
    p_material_id, p_process_code, trim(p_label),
    jsonb_set(COALESCE(p_metadata, '{}'::jsonb), '{graphProductId}', to_jsonb(p_graph_product_id::text), true),
    CASE WHEN p_source_document_id IS NULL THEN 'declared'::data_value_status ELSE 'documented'::data_value_status END,
    p_source_document_id, tracefab_current_user_id(), p_observed_at
  ) RETURNING * INTO v_node;
  RETURN v_node;
END;
$$;

COMMENT ON FUNCTION public.tracefab_create_supply_chain_node(UUID, node_type, TEXT, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, DATE) IS
  'Cree un noeud du graphe versionne. Depuis 20261108120000 : statut ENUM explicitement type (le CASE non type echouait en 42804 a l execution).';

-- ----------------------------------------------------------------------------
-- 2. Le meme defaut, sur la mise a jour des noeuds du graphe
--
-- `20261020120000_structured_supply_chain_graph_membership` definit
-- `tracefab_update_supply_chain_node` avec un `CASE` de litteraux non type :
--
--     status = CASE WHEN p_source_document_id IS NULL THEN 'declared'
--                   ELSE 'documented' END
--
-- La colonne `status` est de type ENUM `data_value_status`. Dans un `UPDATE`,
-- PostgreSQL resout un `CASE` de litteraux en `text` et refuse l'affectation :
--
--     ERROR 42804: column "status" is of type data_value_status but expression
--                  is of type text
--
-- Mesure : l'appel reel de l'ingestion PLM echoue en 42804 APRES la correction
-- du `ON CONFLICT`, sur une base ou la chaine complete est appliquee. Le defaut
-- est donc INDEPENDANT des PR : il est dans la chaine actuelle, et il
-- n'apparait qu'a l'execution — jamais au replay.
--
-- Correctif : typage explicite du `CASE`. Aucune autre modification, aucun
-- privilege accorde ou retire, aucune politique touchee.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_update_supply_chain_node(
  p_graph_product_id UUID, p_node_id UUID, p_label TEXT, p_metadata JSONB,
  p_source_document_id UUID DEFAULT NULL, p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_product tracefab_products; v_node supply_chain_nodes;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_graph_product_id;
  IF NOT FOUND OR NOT tracefab_has_org_role(v_product.brand_organization_id,
    ARRAY['owner','admin','manager','contributor']::membership_role[])
    THEN RAISE EXCEPTION 'traceability_brand_role_required'; END IF;
  IF length(trim(COALESCE(p_label, ''))) = 0 THEN RAISE EXCEPTION 'traceability_node_label_required'; END IF;
  UPDATE supply_chain_nodes SET label = trim(p_label), metadata = COALESCE(p_metadata, '{}'::jsonb),
    source_document_id = p_source_document_id,
    status = CASE WHEN p_source_document_id IS NULL THEN 'declared'::data_value_status ELSE 'documented'::data_value_status END,
    declared_by = tracefab_current_user_id(), observed_at = p_observed_at
  WHERE id = p_node_id AND graph_product_id = p_graph_product_id RETURNING * INTO v_node;
  IF NOT FOUND THEN RAISE EXCEPTION 'traceability_node_not_in_product_graph'; END IF;
  RETURN v_node;
END;
$$;

COMMENT ON FUNCTION public.tracefab_update_supply_chain_node(UUID, UUID, TEXT, JSONB, UUID, DATE) IS
  'Met a jour un noeud du graphe versionne. Depuis 20261108120000 : statut ENUM explicitement type (le CASE non type echouait en 42804 a l execution).';

COMMENT ON FUNCTION public.tracefab_ingest_plm_erp_payload(UUID, TEXT, JSONB, UUID) IS
  'Ingestion PLM/ERP (Centric, Lectra, SAP, GS1). SECURITY DEFINER : execution reservee a tracefab_app, au superutilisateur ou au proprietaire de la fonction. Identite derivee de tracefab.user_id, qui n''est PAS une preuve a lui seul : '
  'l autorisation technique vient du role de session. search_path epingle a pg_catalog, public. Ingestion compatible avec le graphe de tracabilite versionne. Depuis 20261108120000.';
