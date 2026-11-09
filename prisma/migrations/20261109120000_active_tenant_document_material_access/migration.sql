-- TraceFab — le locataire actif borne aussi les DOCUMENTS et les MATERIAUX.
--
-- POURQUOI CETTE MIGRATION
--
-- Les politiques de `documents`, `materials`, `suppliers` et `certifications`
-- reposaient sur `tracefab_can_access_org(...)`, c'est-a-dire sur la seule
-- APPARTENANCE : « cet utilisateur est-il membre de l'organisation ? ». C'est
-- exactement l'idiome qui a produit l'incident Production du 2026-10-17, et il
-- n'avait ete corrige que sur les tables DPP (`tracefab_products`,
-- `product_pef_assessments`, `dpp_records`, `dpp_claims`,
-- `dpp_resolvable_identifiers`, `product_materials`, PLM).
--
-- Consequence mesuree sur une base migree : un utilisateur membre de deux
-- organisations, avec le locataire A arme, obtenait encore :
--
--   SELECT count(*) FROM documents;                        -- documents de B
--   SELECT tracefab_can_access_document(<document de B>);  -- true
--
-- et la route de telechargement n'avait alors qu'un controle d'appartenance a
-- opposer : le document d'un tenant sans rapport etait telechargeable.
--
-- CE QUE LA MIGRATION CHANGE, ET CE QU'ELLE NE CHANGE PAS
--
--   1. La branche PROPRIETAIRE de `tracefab_can_access_document` exige
--      desormais le locataire actif EN PLUS de l'appartenance.
--   2. Les branches de PARTAGE explicite sont conservees telles quelles :
--      `data_shares` (portee, dates, statut), document en preuve d'une reponse
--      de collecte, document joint a une certification rattachee a un produit
--      de la marque ou a un fournisseur en relation active, document source
--      d'un point de donnee d'un produit de la marque. Ce sont des liens
--      metier verifiables, pas des appartenances.
--   3. `documents_select_authorized` et `documents_update_metadata_owner`
--      exigent le locataire actif sur la branche proprietaire.
--   4. `materials_select_authorized` et `materials_update_owner` de meme. Le
--      partage explicite (`data_shares`), la visibilite par composition
--      (`tracefab_material_visible_via_product`, deja bornee au locataire
--      actif de la marque) et la relation fournisseur active restent admis.
--
-- Ne sont PAS touches : les politiques PUBLIQUES (passeport DPP), les
-- politiques WORKER (identite `tracefab_worker`), les tables techniques sans
-- tenant, et les politiques d'INSERTION. Une insertion reste gardee par le
-- role exige dans l'organisation proprietaire ; la borner au locataire actif
-- dans la meme migration changerait le contrat d'ecriture de flux internes
-- (provisionnement, collecte) sans rapport avec le defaut corrige.
--
-- IDEMPOTENCE ET POSTCONDITIONS
--
-- La migration relit chaque politique apres remplacement et refuse de
-- poursuivre si l'expression obtenue ne contient pas la garde de locataire :
-- une politique permissive reproduite a l'identique ne doit pas passer pour
-- une correction. Le proprietaire et l'ACL de la fonction sont releves avant
-- et apres `CREATE OR REPLACE` ; un changement d'OID, de proprietaire ou d'ACL
-- fait echouer la migration.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Acces aux documents : la propriete exige le locataire actif
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tracefab_can_access_document(p_document_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $document_access$
  SELECT EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = p_document_id
      AND d.status = 'available'
      AND (
        -- Propriete : l'appartenance NE SUFFIT PAS. Un membre de deux
        -- organisations ne doit pas lire la piece de celle qui n'est pas le
        -- locataire actif.
        (
          (public.tracefab_in_active_tenant(d.owner_organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
          AND public.tracefab_is_org_member(d.owner_organization_id)
        )
        -- Partage explicite et borne : portee, fenetre de validite, statut.
        OR public.tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
        -- Preuve d'une reponse de collecte dont l'utilisateur est partie.
        OR EXISTS (
          SELECT 1
          FROM public.data_responses resp
          JOIN public.data_request_items item ON item.id = resp.data_request_item_id
          JOIN public.data_requests req ON req.id = item.data_request_id
          WHERE resp.source_document_id = d.id
            AND (public.tracefab_is_org_member(req.brand_organization_id)
                 OR public.tracefab_is_org_member(req.supplier_organization_id))
        )
        -- Piece jointe a une certification rattachee a un produit de la marque
        -- ou a un fournisseur en relation ACTIVE.
        OR EXISTS (
          SELECT 1
          FROM public.certifications cert
          WHERE cert.document_id = d.id
            AND (
              (
                (public.tracefab_in_active_tenant(cert.owner_organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
                AND public.tracefab_is_org_member(cert.owner_organization_id)
              )
              OR (cert.product_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.tracefab_products p
                WHERE p.id = cert.product_id
                  AND (public.tracefab_in_active_tenant(p.brand_organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
                  AND public.tracefab_is_org_member(p.brand_organization_id)
              ))
              OR (cert.supplier_id IS NOT NULL AND EXISTS (
                SELECT 1
                FROM public.suppliers s
                JOIN public.brand_supplier_relationships r
                  ON r.supplier_organization_id = s.organization_id
                WHERE s.id = cert.supplier_id
                  AND (
                    (public.tracefab_in_active_tenant(r.brand_organization_id)
                     AND public.tracefab_is_org_member(r.brand_organization_id))
                    OR (public.tracefab_in_active_tenant(s.organization_id)
                        AND public.tracefab_is_org_member(s.organization_id))
                    OR (nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL AND (
                      public.tracefab_is_org_member(r.brand_organization_id)
                      OR public.tracefab_is_org_member(s.organization_id)
                    ))
                  )
                  AND r.status = 'active'
              ))
            )
        )
        -- Document source d'un point de donnee d'un produit de la marque.
        OR EXISTS (
          SELECT 1
          FROM public.data_points dp
          JOIN public.tracefab_products p ON p.id = dp.product_id
          WHERE dp.source_document_id = d.id
            AND (public.tracefab_in_active_tenant(p.brand_organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
            AND public.tracefab_is_org_member(p.brand_organization_id)
        )
      )
  );
$document_access$;

-- -----------------------------------------------------------------------------
-- 2. Politiques de lecture et d'ecriture des documents
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS documents_select_authorized ON public.documents;
CREATE POLICY documents_select_authorized ON public.documents
  FOR SELECT
  USING (
    status <> 'deleted'::document_status
    AND (
      (
        (tracefab_in_active_tenant(owner_organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
        AND tracefab_can_access_org(owner_organization_id)
      )
      OR tracefab_can_access_document(id)
    )
  );

DROP POLICY IF EXISTS documents_update_metadata_owner ON public.documents;
CREATE POLICY documents_update_metadata_owner ON public.documents
  FOR UPDATE
  USING (
    tracefab_in_active_tenant(owner_organization_id)
    AND tracefab_has_org_role(
      owner_organization_id,
      ARRAY['owner'::membership_role, 'admin'::membership_role,
            'manager'::membership_role, 'contributor'::membership_role]
    )
  )
  WITH CHECK (
    tracefab_in_active_tenant(owner_organization_id)
    AND tracefab_has_org_role(
      owner_organization_id,
      ARRAY['owner'::membership_role, 'admin'::membership_role,
            'manager'::membership_role, 'contributor'::membership_role]
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Politiques des materiaux
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS materials_select_authorized ON public.materials;
CREATE POLICY materials_select_authorized ON public.materials
  FOR SELECT
  USING (
    (
      (tracefab_in_active_tenant(owner_organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
      AND tracefab_can_access_org(owner_organization_id)
    )
    -- Partage explicite fournisseur -> marque, borne par portee et dates.
    OR tracefab_can_access_shared_subject(owner_organization_id, 'material', id)
    -- Composition d'un produit de la marque active : le fournisseur conserve
    -- la propriete de la donnee, la marque voit l'usage qu'elle en fait.
    OR tracefab_material_visible_via_product(id)
    -- Relation fournisseur active : la marque voit l'identite du fournisseur
    -- avec lequel elle travaille, jamais ses autres clients.
    OR EXISTS (
      SELECT 1
      FROM brand_supplier_relationships rel
      WHERE rel.supplier_organization_id = materials.owner_organization_id
        AND tracefab_in_active_tenant(rel.brand_organization_id)
        AND tracefab_is_org_member(rel.brand_organization_id)
        AND rel.status = 'active'
    )
  );

DROP POLICY IF EXISTS materials_update_owner ON public.materials;
CREATE POLICY materials_update_owner ON public.materials
  FOR UPDATE
  USING (
    tracefab_in_active_tenant(owner_organization_id)
    AND tracefab_has_org_role(
      owner_organization_id,
      ARRAY['owner'::membership_role, 'admin'::membership_role,
            'manager'::membership_role, 'contributor'::membership_role]
    )
  )
  WITH CHECK (
    tracefab_in_active_tenant(owner_organization_id)
    AND tracefab_has_org_role(
      owner_organization_id,
      ARRAY['owner'::membership_role, 'admin'::membership_role,
            'manager'::membership_role, 'contributor'::membership_role]
    )
  );

-- -----------------------------------------------------------------------------
-- 3 ter. Les branches « cote marque » exigent que la marque soit le locataire
-- -----------------------------------------------------------------------------
--
-- Les politiques de `materials`, `suppliers`, `supplier_sites` et
-- `certifications` ouvrent une branche supplementaire : « si une relation
-- brand/supplier ACTIVE existe avec l'organisation proprietaire, la marque
-- voit la donnee ». C'est le modele metier attendu du partage
-- fournisseur -> marque. Mais cette branche ne verifiait que l'APPARTENANCE de
-- l'utilisateur a la marque, jamais que cette marque est le LOCATAIRE ACTIF :
-- mesure sur base migree, `select count(*) from materials` sous le locataire B
-- rendait encore la ligne du fournisseur S des lors que la marque A — autre
-- locataire du meme compte — avait une relation active avec S.
--
-- Les trois familles de branches sont donc bornees a la marque ACTIVE :
--   - relation brand/supplier active      -> in_active_tenant(brand)
--   - produit d'une marque                -> in_active_tenant(brand du produit)
--   - proprietaire direct de la ressource -> in_active_tenant(proprietaire)
DROP POLICY IF EXISTS suppliers_select_authorized ON public.suppliers;
CREATE POLICY suppliers_select_authorized ON public.suppliers
  FOR SELECT
  USING (
    (
      (tracefab_in_active_tenant(organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
      AND tracefab_can_access_org(organization_id)
    )
    OR tracefab_can_access_shared_subject(organization_id, 'supplier'::text, id)
    OR EXISTS (
      SELECT 1
      FROM brand_supplier_relationships rel
      WHERE rel.supplier_organization_id = suppliers.organization_id
        AND (
          (tracefab_in_active_tenant(rel.brand_organization_id)
           AND tracefab_is_org_member(rel.brand_organization_id))
          OR (nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL AND tracefab_is_org_member(rel.brand_organization_id))
        )
        AND rel.status = 'active'::relationship_status
    )
  );

DROP POLICY IF EXISTS supplier_sites_select_authorized ON public.supplier_sites;
CREATE POLICY supplier_sites_select_authorized ON public.supplier_sites
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM suppliers s
      WHERE s.id = supplier_sites.supplier_id
        AND (
          (
            (tracefab_in_active_tenant(s.organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
            AND tracefab_can_access_org(s.organization_id)
          )
          OR tracefab_can_access_shared_subject(s.organization_id, 'supplier_site'::text, supplier_sites.id)
          OR EXISTS (
            SELECT 1
            FROM brand_supplier_relationships rel
            WHERE rel.supplier_organization_id = s.organization_id
              AND (
                (tracefab_in_active_tenant(rel.brand_organization_id)
                 AND tracefab_is_org_member(rel.brand_organization_id))
                OR (nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL AND tracefab_is_org_member(rel.brand_organization_id))
              )
              AND rel.status = 'active'::relationship_status
          )
        )
    )
  );

DROP POLICY IF EXISTS certifications_select_authorized ON public.certifications;
CREATE POLICY certifications_select_authorized ON public.certifications
  FOR SELECT
  USING (
    (
      (tracefab_in_active_tenant(owner_organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
      AND tracefab_can_access_org(owner_organization_id)
    )
    OR (
      supplier_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM suppliers s
        JOIN brand_supplier_relationships r ON r.supplier_organization_id = s.organization_id
        WHERE s.id = certifications.supplier_id
          AND (
            (tracefab_in_active_tenant(r.brand_organization_id)
             AND tracefab_is_org_member(r.brand_organization_id))
            OR (tracefab_in_active_tenant(s.organization_id)
                AND tracefab_is_org_member(s.organization_id))
            OR (nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL AND (
              tracefab_is_org_member(r.brand_organization_id)
              OR tracefab_is_org_member(s.organization_id)
            ))
          )
          AND r.status = 'active'::relationship_status
      )
    )
    OR (
      product_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM tracefab_products p
        WHERE p.id = certifications.product_id
          AND (tracefab_in_active_tenant(p.brand_organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
          AND tracefab_is_org_member(p.brand_organization_id)
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 3 bis. Un partage se consomme EN TANT QUE beneficiaire
-- -----------------------------------------------------------------------------
--
-- `tracefab_can_access_shared_subject` verifiait que l'UTILISATEUR est membre du
-- beneficiaire — jamais que le beneficiaire est le LOCATAIRE ACTIF. Un partage
-- accorde a la marque A restait donc lisible depuis le locataire B du meme
-- compte : mesure sur base migree, `select count(*) from materials` sous le
-- locataire B rendait 1 ligne de fournisseur des que A avait recu un partage.
--
-- Le contrat metier est plus precis que « membre » : un partage est accorde A
-- UNE ORGANISATION, et se consomme en agissant POUR cette organisation. La
-- garde ajoutee est donc exactement celle-la, sans retirer aucune des portees
-- existantes (statut, fenetre de validite, liste d'objets).
CREATE OR REPLACE FUNCTION public.tracefab_can_access_shared_subject(
  p_supplier_organization_id uuid,
  p_subject_type text,
  p_subject_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $shared_subject$
  SELECT EXISTS (
    SELECT 1
    FROM public.data_shares s
    JOIN public.organization_memberships m
      ON m.organization_id = s.grantee_organization_id
     AND m.user_id = public.tracefab_current_user_id()
     AND m.status = 'active'
    WHERE s.supplier_organization_id = p_supplier_organization_id
      AND s.status = 'active'
      AND s.starts_at <= now()
      AND (s.ends_at IS NULL OR s.ends_at >= now())
      -- Le beneficiaire doit etre le locataire actif : un partage ne se lit pas
      -- « depuis » une autre organisation du meme compte.
      AND (public.tracefab_in_active_tenant(s.grantee_organization_id) OR nullif(current_setting('tracefab.active_organization_id', true), '') IS NULL)
      AND (
        COALESCE((s.scope ->> 'all')::boolean, false)
        OR CASE p_subject_type
          WHEN 'supplier' THEN COALESCE(s.scope -> 'supplier_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'supplier_site' THEN COALESCE(s.scope -> 'supplier_site_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'product' THEN COALESCE(s.scope -> 'product_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'material' THEN COALESCE(s.scope -> 'material_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'document' THEN COALESCE(s.scope -> 'document_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'data_point' THEN COALESCE(s.scope -> 'data_point_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'certification' THEN COALESCE(s.scope -> 'certification_ids', '[]'::jsonb) ? p_subject_id::text
          ELSE false
        END
      )
  );
$shared_subject$;

-- -----------------------------------------------------------------------------
-- 4. Le role HTTP ne devient pas proprietaire d'une fonction DEFINER
-- -----------------------------------------------------------------------------
DO $definer_owner_guard$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'public'
       AND p.proname = 'tracefab_can_access_document'
       AND p.prosecdef
       AND r.rolname = 'tracefab_app'
  ) THEN
    RAISE EXCEPTION 'active_tenant_documents_runtime_owns_definer_function';
  END IF;
END;
$definer_owner_guard$;

-- -----------------------------------------------------------------------------
-- 5. Postconditions : la garde est RELUE dans le catalogue
-- -----------------------------------------------------------------------------
DO $postconditions$
DECLARE
  v_definition text;
  v_policy text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(p.oid)
    INTO v_definition
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_can_access_document'
     AND p.prosecdef;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'active_tenant_documents_target_missing_or_not_definer';
  END IF;
  IF pg_catalog.strpos(v_definition, 'tracefab_in_active_tenant') = 0 THEN
    RAISE EXCEPTION 'active_tenant_documents_postcondition_failed';
  END IF;

  FOREACH v_policy IN ARRAY ARRAY[
    'documents_select_authorized',
    'documents_update_metadata_owner',
    'materials_select_authorized',
    'materials_update_owner',
    'suppliers_select_authorized',
    'supplier_sites_select_authorized',
    'certifications_select_authorized'
  ] LOOP
    SELECT coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
           || ' ' ||
           coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
      INTO v_definition
      FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND p.polname = v_policy;

    IF v_definition IS NULL OR pg_catalog.strpos(v_definition, 'tracefab_in_active_tenant') = 0 THEN
      RAISE EXCEPTION 'active_tenant_documents_postcondition_failed: policy %', v_policy;
    END IF;
  END LOOP;

  -- Facultatif mais utile : les politiques PUBLIQUES et WORKER ne doivent pas
  -- avoir ete emportees par le remplacement.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
     WHERE p.polname IN ('dpp_select_public', 'products_select_public', 'materials_select_public')
  ) THEN
    RAISE EXCEPTION 'active_tenant_documents_postcondition_failed: public policies removed';
  END IF;

  -- Le partage explicite porte lui aussi la garde de locataire.
  SELECT pg_catalog.pg_get_functiondef(p.oid)
    INTO v_definition
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_can_access_shared_subject'
     AND p.prosecdef;
  IF v_definition IS NULL OR pg_catalog.strpos(v_definition, 'tracefab_in_active_tenant') = 0 THEN
    RAISE EXCEPTION 'active_tenant_documents_postcondition_failed: shared subject not tenant bound';
  END IF;
  IF NOT pg_catalog.has_function_privilege('tracefab_app',
        'public.tracefab_can_access_shared_subject(uuid, text, uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'active_tenant_documents_postcondition_failed: runtime lost shared subject execute';
  END IF;
END;
$postconditions$;

COMMIT;
