-- ============================================================================
-- 20261106010000 — gardes d'autorisation liees au locataire ACTIF, cote base
--
-- MISSION : isolation globale des acces et du stockage (PR #109, suite).
--
-- CONSTAT MESURE (chaine de migrations rebasee sur main, 09/11/2026)
--   La migration 20261105235900_active_tenant_policy_and_worker_closure a deja
--   borne les lectures RLS et `tracefab_can_access_document` au tenant actif :
--   avec le tenant A arme, les documents prives de B et S sont refuses.
--   Le manque restant concerne les gardes explicites utilises par les routes
--   pour autoriser un acces direct par identifiant exact. Ces deux helpers
--   dedies n'existent pas encore avant la presente migration.
--
-- CE QUE FAIT CETTE MIGRATION (additive, aucun fichier historique modifie)
--   1. `tracefab_document_accessible_in_active_tenant(uuid)` : decision
--      d'autorisation documentaire EXECUTEE EN BASE, fail-closed, liee au
--      tenant actif, a l'adhesion active et aux partages/relations legitimes.
--   2. `tracefab_product_accessible_in_active_tenant(uuid)` : meme contrat
--      pour les acces directs aux produits par identifiant.
--   3. Enregistrement des deux noms au registre runtime, puis redistribution
--      des droits par `tracefab_apply_runtime_function_grants()` : aucun
--      GRANT EXECUTE direct, aucune ouverture a PUBLIC.
--
-- CE QU'ELLE NE FAIT PAS
--   - elle ne modifie aucune politique RLS existante : les politiques restent
--     bornees a l'adhesion, ce qui preserve les parcours fournisseur ;
--   - elle ne retire aucune fonction ni aucune permission ;
--   - elle ne touche a aucune donnee metier, ni a `_prisma_migrations` ;
--   - elle n'impose PAS un filtre `brandOrganizationId` simpliste : les
--     partages explicites et les relations actives restent des voies d'acces.
--
-- REVERSIBILITE (procedure manuelle, aucune down migration dans le depot)
--   DELETE FROM tracefab_runtime_function_registry
--    WHERE name IN ('tracefab_document_accessible_in_active_tenant',
--                   'tracefab_product_accessible_in_active_tenant');
--   SELECT tracefab_apply_runtime_function_grants();
--   DROP FUNCTION IF EXISTS public.tracefab_document_accessible_in_active_tenant(uuid);
--   DROP FUNCTION IF EXISTS public.tracefab_product_accessible_in_active_tenant(uuid);
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Garde documentaire : identite verifiee + tenant actif + adhesion active
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER est necessaire pour lire les tables de partage et de
-- collecte sans que chaque appelant applicatif ait a recevoir des privileges
-- supplementaires. `search_path` est epingle, EXECUTE retire a PUBLIC, et le
-- role applicatif ne recoit le droit que par le registre (§3).
--
-- MODE STRICT P10.5/P10.6 : `tracefab_current_user_id()` lit l'identite dans le
-- jeton HMAC, dont le corps signe contient l'organisation active. Un GUC
-- `active_organization_id` forge sans jeton valide ne produit donc aucune
-- identite en mode strict. En mode permissif (deploiement progressif), le
-- controle d'adhesion ci-dessous reste la barriere : un locataire ou l'appelant
-- n'a pas d'adhesion active ne donne acces a rien.
CREATE OR REPLACE FUNCTION public.tracefab_document_accessible_in_active_tenant(p_document_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $guard_doc$
DECLARE
  v_user     UUID := public.tracefab_current_user_id();
  v_tenant   UUID := public.tracefab_active_organization_id();
  v_type     organization_type;
  v_owner    UUID;
  v_status   document_status;
  v_deleted  TIMESTAMPTZ;
BEGIN
  -- Absence d'identite, de tenant ou d'adhesion active : refus, jamais repli
  -- sur « toutes les organisations du compte ».
  IF p_document_id IS NULL OR v_user IS NULL OR v_tenant IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = v_user
       AND m.organization_id = v_tenant
       AND m.status = 'active'
  ) THEN
    RETURN false;
  END IF;

  SELECT o.type INTO v_type FROM public.organizations o WHERE o.id = v_tenant;
  IF v_type IS NULL THEN RETURN false; END IF;

  SELECT d.owner_organization_id, d.status, d.deleted_at
    INTO v_owner, v_status, v_deleted
    FROM public.documents d
   WHERE d.id = p_document_id;
  IF NOT FOUND OR v_status <> 'available' OR v_deleted IS NOT NULL THEN
    RETURN false;
  END IF;

  -- Proprietaire : le seul cas ou l'appartenance suffit, parce qu'elle porte
  -- exactement sur le tenant actif.
  IF v_owner = v_tenant THEN RETURN true; END IF;

  -- Voies inter-organisations LEGITIMES, toutes bornees au tenant actif.
  -- Une relation revendue, suspendue ou terminee retire immediatement les
  -- droits : chaque branche qui traverse une marque et un fournisseur exige
  -- `brand_supplier_relationships.status = 'active'` quand la relation est
  -- identifiable.
  IF v_type = 'brand' THEN
    RETURN COALESCE(
      -- (a) partage explicite : grantee = marque active, relation active,
      --     perimetre dans le temps, et document dans le scope du partage.
      EXISTS (
        SELECT 1
          FROM public.data_shares sh
          JOIN public.brand_supplier_relationships r
            ON r.id = sh.relationship_id
           AND r.status = 'active'
           AND r.brand_organization_id = v_tenant
         WHERE sh.grantee_organization_id = v_tenant
           AND sh.status = 'active'
           AND sh.starts_at <= pg_catalog.now()
           AND (sh.ends_at IS NULL OR sh.ends_at >= pg_catalog.now())
           AND (sh.supplier_organization_id = v_owner
                OR r.supplier_organization_id = v_owner
                OR r.brand_organization_id = v_owner)
           AND (COALESCE((sh.scope ->> 'all')::boolean, false)
                OR COALESCE(sh.scope -> 'document_ids', '[]'::jsonb) ? p_document_id::text)
      )
      -- (b) preuve d'une reponse a une demande de la marque active.
      OR EXISTS (
        SELECT 1
          FROM public.data_responses resp
          JOIN public.data_request_items item ON item.id = resp.data_request_item_id
          JOIN public.data_requests req ON req.id = item.data_request_id
         WHERE resp.source_document_id = p_document_id
           AND req.brand_organization_id = v_tenant
           AND (req.relationship_id IS NULL OR EXISTS (
             SELECT 1 FROM public.brand_supplier_relationships r
              WHERE r.id = req.relationship_id
                AND r.status = 'active'
                AND r.brand_organization_id = v_tenant))
      )
      -- (c) certificat possede par la marque active.
      OR EXISTS (
        SELECT 1 FROM public.certifications cert
         WHERE cert.document_id = p_document_id
           AND cert.owner_organization_id = v_tenant
      )
      -- (d) certificat rattache a un produit de la marque active.
      OR EXISTS (
        SELECT 1
          FROM public.certifications cert
          JOIN public.tracefab_products p ON p.id = cert.product_id
         WHERE cert.document_id = p_document_id
           AND p.brand_organization_id = v_tenant
      )
      -- (e) certificat FOURNISSEUR via une relation ACTIVE avec la marque.
      --     Le certificat ET le document doivent appartenir au fournisseur :
      --     sans cette double condition, une marque A pourrait deposer un
      --     certificat nommant le fournisseur S, et la marque B (autre
      --     relation active avec S) obtiendrait un document de A. Mesure et
      --     corrige par le scenario 3 de test_isolation_globale_pglite.mjs.
      OR EXISTS (
        SELECT 1
          FROM public.certifications cert
          JOIN public.suppliers s ON s.id = cert.supplier_id
          JOIN public.brand_supplier_relationships r
            ON r.supplier_organization_id = s.organization_id
           AND r.brand_organization_id = v_tenant
           AND r.status = 'active'
         WHERE cert.document_id = p_document_id
           AND cert.owner_organization_id = s.organization_id
           AND v_owner = s.organization_id
      )
      -- (f) point de donnee d'un produit de la marque active.
      OR EXISTS (
        SELECT 1
          FROM public.data_points dp
          JOIN public.tracefab_products p ON p.id = dp.product_id
         WHERE dp.source_document_id = p_document_id
           AND p.brand_organization_id = v_tenant
      ),
      false);
  ELSIF v_type = 'supplier' THEN
    RETURN COALESCE(
      -- (a) partage explicite dont le fournisseur actif est le beneficiaire.
      EXISTS (
        SELECT 1
          FROM public.data_shares sh
          JOIN public.brand_supplier_relationships r
            ON r.id = sh.relationship_id
           AND r.status = 'active'
           AND (r.supplier_organization_id = v_tenant
                OR r.brand_organization_id = v_owner)
         WHERE sh.grantee_organization_id = v_tenant
           AND sh.status = 'active'
           AND sh.starts_at <= pg_catalog.now()
           AND (sh.ends_at IS NULL OR sh.ends_at >= pg_catalog.now())
           AND (sh.supplier_organization_id = v_owner
                OR r.supplier_organization_id = v_owner
                OR r.brand_organization_id = v_owner)
           AND (COALESCE((sh.scope ->> 'all')::boolean, false)
                OR COALESCE(sh.scope -> 'document_ids', '[]'::jsonb) ? p_document_id::text)
      )
      -- (b) preuve d'une reponse a une demande adressee au fournisseur actif.
      OR EXISTS (
        SELECT 1
          FROM public.data_responses resp
          JOIN public.data_request_items item ON item.id = resp.data_request_item_id
          JOIN public.data_requests req ON req.id = item.data_request_id
         WHERE resp.source_document_id = p_document_id
           AND req.supplier_organization_id = v_tenant
           AND (req.relationship_id IS NULL OR EXISTS (
             SELECT 1 FROM public.brand_supplier_relationships r
              WHERE r.id = req.relationship_id
                AND r.status = 'active'
                AND r.supplier_organization_id = v_tenant))
      )
      -- (c) certificat possede par le fournisseur actif.
      OR EXISTS (
        SELECT 1 FROM public.certifications cert
         WHERE cert.document_id = p_document_id
           AND cert.owner_organization_id = v_tenant
      )
      -- (d) certificat emis par une marque AU NOM du fournisseur actif :
      --     partage explicite, exigeant une relation ACTIVE avec cette marque
      --     et un document possede par elle. Une marque sans relation ne peut
      --     pas deposer un document dans le perimetre du fournisseur.
      OR EXISTS (
        SELECT 1
          FROM public.certifications cert
          JOIN public.suppliers s ON s.id = cert.supplier_id
          JOIN public.brand_supplier_relationships r
            ON r.brand_organization_id = cert.owner_organization_id
           AND r.supplier_organization_id = v_tenant
           AND r.status = 'active'
         WHERE cert.document_id = p_document_id
           AND s.organization_id = v_tenant
           AND cert.owner_organization_id = v_owner
      ),
      false);
  END IF;

  -- Types d'organisation non metier (platform, verifier) : aucun acces
  -- inter-organisations par defaut.
  RETURN false;
END
$guard_doc$;

COMMENT ON FUNCTION public.tracefab_document_accessible_in_active_tenant(UUID) IS
  'Autorisation documentaire liee au tenant ACTIF : identite verifiee, adhesion active, '
  'propriete, partage explicite dans son perimetre, ou relation fournisseur-marque active. '
  'Booleen total, fail-closed. Ne remplace pas les politiques RLS : elle les complete.';

-- ---------------------------------------------------------------------------
-- 2. Garde produit : aucun acces direct par identifiant hors tenant actif
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tracefab_product_accessible_in_active_tenant(p_product_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $guard_product$
DECLARE
  v_user   UUID := public.tracefab_current_user_id();
  v_tenant UUID := public.tracefab_active_organization_id();
BEGIN
  IF p_product_id IS NULL OR v_user IS NULL OR v_tenant IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = v_user
       AND m.organization_id = v_tenant
       AND m.status = 'active'
  ) THEN
    RETURN false;
  END IF;
  RETURN COALESCE((
    SELECT EXISTS (
      SELECT 1 FROM public.tracefab_products p
       WHERE p.id = p_product_id
         AND p.brand_organization_id = v_tenant
    )
  ), false);
END
$guard_product$;

COMMENT ON FUNCTION public.tracefab_product_accessible_in_active_tenant(UUID) IS
  'Acces a un produit par identifiant, borne au tenant actif et a une adhesion active. '
  'Aucun repli sur les autres organisations du compte.';

-- ---------------------------------------------------------------------------
-- 3. Privileges : fermeture explicite, puis registre unique
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.tracefab_document_accessible_in_active_tenant(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tracefab_product_accessible_in_active_tenant(UUID) FROM PUBLIC;

INSERT INTO public.tracefab_runtime_function_registry (name, registered_by) VALUES
  ('tracefab_document_accessible_in_active_tenant', '20261106010000_active_tenant_access_guards'),
  ('tracefab_product_accessible_in_active_tenant', '20261106010000_active_tenant_access_guards'),
  ('tracefab_document_visible_in_active_tenant', '20261106010000_active_tenant_access_guards')
ON CONFLICT (name) DO NOTHING;

-- Le registre est la seule source des droits EXECUTE de `tracefab_app`.
-- L'appel est reporte en fin de migration : la section 5 cree une troisieme
-- fonction declaree ci-dessus, et le redistributeur exige que CHAQUE nom du
-- registre corresponde a une fonction existante au moment ou il s'execute.

-- ---------------------------------------------------------------------------
-- 4. Compatibilite avec les fonctions RLS historiques
--
--    La migration 20261105235900_active_tenant_policy_and_worker_closure a deja
--    lie les fonctions RLS historiques au tenant actif. La presente migration
--    ajoute les gardes explicites pour les routes qui autorisent un acces par
--    identifiant exact, puis les integre aux fonctions historiques sans
--    supprimer ni remplacer les politiques RLS.
--
--    Mesure (section A de scripts/test_isolation_globale_pglite.mjs) :
--      AVANT : RLS et tracefab_can_access_document refusent deja B et S depuis A ;
--              les helpers document/product dedies aux routes sont absents.
--      APRES : les helpers existent, refusent les ID hors tenant actif et
--              acceptent les partages/relations metier explicitement autorises.
--
--    CREATE OR REPLACE preserve OID, proprietaire et ACL des fonctions
--    historiques. Sans tenant actif, leur comportement RLS historique est
--    conserve ; les nouveaux helpers de route, eux, refusent tout acces :
--      - `tracefab_can_access_document` -> propriete du tenant actif (tout etat
--        non supprime, pour ne pas casser le cycle upload/scan) ou garde
--        `tracefab_document_accessible_in_active_tenant` (partages, collecte,
--        certifications, points de donnee) ;
--      - `tracefab_can_access_shared_subject` -> le partage doit avoir le
--        tenant actif comme beneficiaire explicite.
--    Les politiques RLS existantes ne sont ni supprimees ni remplacees : elles
--    appellent ces fonctions, qui deviennent elles-memes liees au tenant.
--
--    REVERSIBILITE : rejouer les deux definitions de
--    20261006100000_security_force_rls_and_document_access et
--    20260923130000_tracefab_neon_initial (§ tracefab_can_access_shared_subject)
--    dans cet ordre, puis `SELECT tracefab_apply_runtime_function_grants()`.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tracefab_can_access_shared_subject(
  p_supplier_organization_id UUID,
  p_subject_type TEXT,
  p_subject_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $shared_tenant$
  SELECT EXISTS (
    SELECT 1
      FROM public.data_shares s
      JOIN public.organization_memberships m
        ON m.organization_id = s.grantee_organization_id
       AND m.user_id = public.tracefab_current_user_id()
       AND m.status = 'active'
     WHERE s.supplier_organization_id = p_supplier_organization_id
       AND s.status = 'active'
       AND s.starts_at <= pg_catalog.now()
       AND (s.ends_at IS NULL OR s.ends_at >= pg_catalog.now())
       -- Sans tenant arme : comportement historique (worker, public, compte).
       -- Avec tenant arme : seul le beneficiaire EXPLICITE du partage compte.
       AND (
         public.tracefab_active_organization_id() IS NULL
         OR s.grantee_organization_id = public.tracefab_active_organization_id()
       )
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
$shared_tenant$;

COMMENT ON FUNCTION public.tracefab_can_access_shared_subject(UUID, TEXT, UUID) IS
  'Partage explicite, borne au locataire ACTIF quand il est arme. Sans locataire '
  'arme, comportement historique inchange (contextes worker/public/compte).';

CREATE OR REPLACE FUNCTION public.tracefab_can_access_document(p_document_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $doc_tenant$
  SELECT CASE
    -- Aucun tenant arme : politique historique, bornee a l'utilisateur.
    WHEN public.tracefab_active_organization_id() IS NULL THEN
      EXISTS (
        SELECT 1 FROM public.documents d
         WHERE d.id = p_document_id
           AND d.status = 'available'
           AND (
             public.tracefab_can_access_org(d.owner_organization_id)
             OR public.tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
             OR EXISTS (
               SELECT 1
                 FROM public.data_responses resp
                 JOIN public.data_request_items item ON item.id = resp.data_request_item_id
                 JOIN public.data_requests req ON req.id = item.data_request_id
                WHERE resp.source_document_id = d.id
                  AND (public.tracefab_is_org_member(req.brand_organization_id)
                       OR public.tracefab_is_org_member(req.supplier_organization_id))
             )
             OR EXISTS (
               SELECT 1 FROM public.certifications cert
                WHERE cert.document_id = d.id
                  AND (
                    public.tracefab_can_access_org(cert.owner_organization_id)
                    OR (cert.product_id IS NOT NULL AND EXISTS (
                      SELECT 1 FROM public.tracefab_products p
                       WHERE p.id = cert.product_id
                         AND public.tracefab_is_org_member(p.brand_organization_id)))
                    OR (cert.supplier_id IS NOT NULL AND EXISTS (
                      SELECT 1 FROM public.suppliers s
                       JOIN public.brand_supplier_relationships r
                         ON r.supplier_organization_id = s.organization_id
                       WHERE s.id = cert.supplier_id
                         AND public.tracefab_is_org_member(r.brand_organization_id)
                         AND r.status = 'active'))
                  )
             )
             OR EXISTS (
               SELECT 1 FROM public.data_points dp
                JOIN public.tracefab_products p ON p.id = dp.product_id
                WHERE dp.source_document_id = d.id
                  AND public.tracefab_is_org_member(p.brand_organization_id)
             )
           )
      )
    -- Tenant arme : propriete du tenant (cycle de vie complet, pas seulement
    -- `available`) ou voies de partage legitimes evaluees par le garde lie au
    -- tenant actif. Une adhesion active est exigee par le garde.
    ELSE
      COALESCE(
        EXISTS (
          SELECT 1 FROM public.documents d
           WHERE d.id = p_document_id
             AND d.owner_organization_id = public.tracefab_active_organization_id()
             AND d.status <> 'deleted'
             AND d.deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM public.organization_memberships m
                WHERE m.user_id = public.tracefab_current_user_id()
                  AND m.organization_id = public.tracefab_active_organization_id()
                  AND m.status = 'active'
             )
        )
        OR public.tracefab_document_accessible_in_active_tenant(p_document_id),
        false)
  END;
$doc_tenant$;

COMMENT ON FUNCTION public.tracefab_can_access_document(UUID) IS
  'Politique RLS documentaire liee au locataire ACTIF quand il est arme ; '
  'comportement historique inchange sans locataire arme. Booleen total.';

-- Les deux fonctions etaient deja declarees au registre : `CREATE OR REPLACE`
-- preserve leur OID, leur proprietaire et leurs droits EXECUTE. Aucun nouveau
-- nom n'est ajoute, aucun GRANT direct n'est pose.

-- ---------------------------------------------------------------------------
-- 5. Politique RESTRICTIVE : la clause `tracefab_can_access_org` de la
--    politique permissive `documents_select_authorized` reste bornee a
--    l'utilisateur (union des adhesions). Les deux fonctions corrigees en
--    section 4 ne suffisent donc pas : PostgreSQL combine les branches
--    permissives par OR. Une politique RESTRICTIVE est combinee par AND avec
--    l'ensemble des politiques permissives ; c'est la seule facon additive de
--    fermer la fuite sans reecrire une politique historique.
--
--    Quand aucun tenant n'est arme (worker, public, compte), la politique rend
--    vrai : aucun parcours historique n'est modifie. Quand un tenant est arme :
--      - adhesion ACTIVE exigee ;
--      - proprietaire = tenant actif : visible dans TOUS les etats non
--        supprimes (depot, scan, reprise, quotas) ;
--      - sinon : uniquement les voies legitimes du garde documentaire lie au
--        tenant actif (partages, collecte, certifications, points de donnee).
--
--    Le predicat recoit les colonnes de la ligne en parametres : il ne relit
--    pas la table `documents` pour le cas proprietaire, ce qui evite la
--    recursivite de politique. Le garde, comme
--    `tracefab_can_access_document` historique, est SECURITY DEFINER et evalue
--    les voies de partage hors RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tracefab_document_visible_in_active_tenant(
  p_document_id UUID,
  p_owner_organization_id UUID,
  p_status document_status,
  p_deleted_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $rls_doc_tenant$
  SELECT CASE
    WHEN public.tracefab_active_organization_id() IS NULL THEN true
    WHEN NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.user_id = public.tracefab_current_user_id()
         AND m.organization_id = public.tracefab_active_organization_id()
         AND m.status = 'active'
    ) THEN false
    WHEN p_status = 'deleted' OR p_deleted_at IS NOT NULL THEN false
    WHEN p_owner_organization_id = public.tracefab_active_organization_id() THEN true
    ELSE COALESCE(public.tracefab_document_accessible_in_active_tenant(p_document_id), false)
  END;
$rls_doc_tenant$;

REVOKE ALL ON FUNCTION public.tracefab_document_visible_in_active_tenant(UUID, UUID, document_status, TIMESTAMPTZ) FROM PUBLIC;

COMMENT ON FUNCTION public.tracefab_document_visible_in_active_tenant(UUID, UUID, document_status, TIMESTAMPTZ) IS
  'Predicat RESTRICTIF de RLS documents : locataire actif, adhesion active, '
  'propriete ou partage legitime. Sans locataire arme : aucune restriction.';

DROP POLICY IF EXISTS documents_restrict_active_tenant ON public.documents;
CREATE POLICY documents_restrict_active_tenant ON public.documents
  AS RESTRICTIVE
  FOR SELECT TO PUBLIC
  USING (
    public.tracefab_document_visible_in_active_tenant(
      id, owner_organization_id, status, deleted_at
    )
  );

-- Fin de migration : le registre contient les trois noms et les trois
-- fonctions existent. Aucun GRANT EXECUTE direct n'a ete pose.
SELECT * FROM public.tracefab_apply_runtime_function_grants();
