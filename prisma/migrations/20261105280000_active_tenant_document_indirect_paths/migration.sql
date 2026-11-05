-- 20261105280000_active_tenant_document_indirect_paths
--
-- DEFAUT MESURE, pas suppose.
--
-- La migration `20261105250000_active_tenant_document_material_access` a borne
-- les branches de PROPRIETE de `tracefab_can_access_document` au locataire
-- actif. Les branches INDIRECTES sont restees sur la seule appartenance :
--
--   - preuve d'une reponse de collecte (`data_responses` / `data_requests`) ;
--   - piece jointe a une certification rattachee a une relation fournisseur ;
--   - document source d'un point de donnee d'un produit.
--
-- Mesure sur PostgreSQL 17, base migree, role `tracefab_app` sans BYPASSRLS,
-- un utilisateur administrateur de la marque A ET de la marque B :
--
--   locataire A actif -> tracefab_can_access_document(<document de B par point
--                        de donnee>) = true   <-- FUITE
--                     -> `select count(*) from documents` sur les trois pieces
--                        de B = 1              <-- la politique
--                        `documents_select_authorized` s'appuie sur cette meme
--                        fonction, la fuite traverse donc la RLS
--   locataire B actif -> true, 3            (acces legitime preserve)
--
-- La politique `documents_select_authorized` n'a pas ete touchee : elle delegue
-- a cette fonction, et corriger la fonction ferme les deux chemins a la fois.
--
-- CE QUE FAIT CETTE MIGRATION
--
-- `CREATE OR REPLACE` de la fonction, sans changer sa signature : OID,
-- proprietaire et ACL sont conserves et verifies. Chaque branche indirecte
-- exige desormais le locataire actif du cote qu'elle autorise, en plus de
-- l'appartenance. Les branches legitimes sont conservees telles quelles :
-- propriete sous le locataire actif, partage explicite (deja borne par le
-- beneficiaire dans 20261105250000), relation fournisseur ACTIVE vue depuis la
-- marque active, piece d'une reponse vue depuis le locataire partie a la
-- demande.
--
-- Aucune migration anterieure n'est reecrite. Aucune politique n'est remplacee
-- ici : le defaut est dans la fonction, et la politique en herite.

DO $mig$
DECLARE
  v_oid oid;
  v_owner name;
  v_acl aclitem[];
  v_un_exemple text;
BEGIN
  SELECT p.oid, pg_get_userbyid(p.proowner), p.proacl
    INTO v_oid, v_owner, v_acl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'tracefab_can_access_document'
    AND pg_get_function_identity_arguments(p.oid) = 'p_document_id uuid';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'indirect_paths_target_missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'indirect_paths_target_not_definer';
  END IF;
  -- Le proprietaire ne doit pas etre le role HTTP : une fonction DEFINER
  -- possedee par le runtime s'executerait avec les droits du runtime, donc
  -- sans apport de privilege — et masquerait une erreur de provisioning.
  IF v_owner = 'tracefab_app' THEN
    RAISE EXCEPTION 'indirect_paths_target_owned_by_runtime';
  END IF;

  CREATE OR REPLACE FUNCTION public.tracefab_can_access_document(p_document_id uuid)
   RETURNS boolean
   LANGUAGE sql
   STABLE SECURITY DEFINER
   SET search_path TO 'pg_catalog', 'public'
  AS $function$

  SELECT EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = p_document_id
      AND d.status = 'available'
      AND (
        -- Propriete : l'appartenance NE SUFFIT PAS. Un membre de deux
        -- organisations ne doit pas lire la piece de celle qui n'est pas le
        -- locataire actif.
        (
          public.tracefab_in_active_tenant(d.owner_organization_id)
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
            AND (
              (public.tracefab_in_active_tenant(req.brand_organization_id)
               AND public.tracefab_is_org_member(req.brand_organization_id))
              OR (public.tracefab_in_active_tenant(req.supplier_organization_id)
                  AND public.tracefab_is_org_member(req.supplier_organization_id))
            )
        )
        -- Piece jointe a une certification rattachee a un produit de la marque
        -- ou a un fournisseur en relation ACTIVE.
        OR EXISTS (
          SELECT 1
          FROM public.certifications cert
          WHERE cert.document_id = d.id
            AND (
              (
                public.tracefab_in_active_tenant(cert.owner_organization_id)
                AND public.tracefab_is_org_member(cert.owner_organization_id)
              )
              OR (cert.product_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.tracefab_products p
                WHERE p.id = cert.product_id
                  AND public.tracefab_in_active_tenant(p.brand_organization_id)
                  AND public.tracefab_is_org_member(p.brand_organization_id)
              ))
              OR (cert.supplier_id IS NOT NULL AND EXISTS (
                SELECT 1
                FROM public.suppliers s
                JOIN public.brand_supplier_relationships r
                  ON r.supplier_organization_id = s.organization_id
                WHERE s.id = cert.supplier_id
                  AND public.tracefab_in_active_tenant(r.brand_organization_id)
                  AND public.tracefab_is_org_member(r.brand_organization_id)
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
            AND public.tracefab_in_active_tenant(p.brand_organization_id)
            AND public.tracefab_is_org_member(p.brand_organization_id)
        )
      )
  );
  $function$;

  -- Preconditions de contenu : la garde doit etre presente sur CHAQUE branche
  -- indirecte, et le partage explicite ne doit pas avoir ete emporte.
  SELECT pg_get_functiondef('public.tracefab_can_access_document(uuid)'::regprocedure)
    INTO v_un_exemple;
  IF v_un_exemple NOT LIKE '%data_responses%' THEN
    RAISE EXCEPTION 'indirect_paths_responses_branch_lost';
  END IF;
  IF v_un_exemple NOT LIKE '%tracefab_can_access_shared_subject%' THEN
    RAISE EXCEPTION 'indirect_paths_shared_branch_lost';
  END IF;

  -- Postconditions : OID, proprietaire, ACL et config de session inchanges.
  IF (SELECT oid FROM pg_proc WHERE proname = 'tracefab_can_access_document'
        AND pronamespace = 'public'::regnamespace
        AND pg_get_function_identity_arguments(oid) = 'p_document_id uuid') <> v_oid THEN
    RAISE EXCEPTION 'indirect_paths_changed_oid';
  END IF;
  IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = v_oid)) <> v_owner THEN
    RAISE EXCEPTION 'indirect_paths_changed_owner';
  END IF;
  IF (SELECT proacl FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'indirect_paths_changed_acl';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = v_oid
      AND proconfig IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'indirect_paths_search_path_unset';
  END IF;
  IF NOT has_function_privilege('tracefab_app', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'indirect_paths_runtime_cannot_execute';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'indirect_paths_executable_by_public';
  END IF;

  -- Les trois branches indirectes portent la garde de locataire actif. Le
  -- compte est volontairement strict : la fonction doit en compter autant que
  -- de branches bornees (propriete, reponses marque, reponses fournisseur,
  -- certification proprietaire, certification produit, certification relation,
  -- point de donnee) — sept occurrences du predicat, plus celle du partage
  -- explicite qui vit dans l'autre fonction.
  IF (SELECT (length(v_un_exemple) - length(replace(v_un_exemple, 'tracefab_in_active_tenant', '')))
        / length('tracefab_in_active_tenant'))
     < 7 THEN
    RAISE EXCEPTION 'indirect_paths_active_tenant_guard_missing';
  END IF;
END
$mig$;
