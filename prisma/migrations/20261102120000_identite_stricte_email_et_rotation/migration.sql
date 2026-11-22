-- ============================================================================
-- 20261102120000 — en mode strict, plus AUCUNE identité hors du jeton signé
--
-- CE QUI EST CORRIGÉ, ET COMMENT C'EST MESURÉ
--
-- La migration 20261031120000 a signé `tracefab.user_id`. Une revue de P10.6 a
-- cherché tout ce qui, dans la base, lit encore une valeur NON SIGNÉE pour en
-- tirer une identité. Trois défauts ont été mesurés sur base jetable, en mode
-- strict (`tracefab_identity_politique.strict = true`) et avec `tracefab_app` :
--
--   D1. `tracefab_current_user_email()` rendait `tracefab.user_email`, un GUC
--       que l'appelant choisit. Mesure : jeton SIGNÉ de l'utilisateur A +
--       `tracefab.user_email = 'pirate@example.test'` -> la fonction rendait
--       `pirate@example.test`. Trois surfaces en dépendent : acceptation
--       d'invitation (l'invitation est appariée par adresse), auto-inscription
--       fournisseur, et la politique `passport_access_select`. L'identité
--       était signée, l'ADRESSE ne l'était pas : on pouvait donc rejoindre une
--       organisation invitée sous l'adresse d'un autre.
--
--   D2. Trois fonctions SECURITY DEFINER lisaient le GUC brut pour attribuer
--       leurs écritures (`transaction_certificates.issued_by`,
--       `mass_balance_allocations.created_by`, etc.) :
--         tracefab_register_transaction_certificate,
--         tracefab_allocate_tc_quantity,
--         tracefab_reconcile_mass_balance.
--       L'autorisation, elle, passait déjà par `tracefab_current_user_id()` :
--       ce n'était donc pas un contournement de privilège, mais une ATTESTATION
--       FORGEABLE — on inscrivait une action au nom d'un autre. En mode strict
--       c'est une incohérence : une identité signée, et une trace non signée.
--
--   D3. La vérification du jeton n'acceptait QUE la clé active de version la
--       plus haute. Toute rotation invalidait donc immédiatement les jetons en
--       vol (durée de vie 60 s) : une rotation provoquait une fenêtre d'échec,
--       ce qui pousse à ne jamais tourner la clé — l'inverse du but.
--
-- CE QUE LA MIGRATION NE FAIT PAS
--   - elle ne modifie AUCUNE migration antérieure : `20260923140000`,
--     `20261006250000`, `20261006260000` et `20261031120000` gardent leur
--     empreinte. Les objets sont remplacés ici, par `CREATE OR REPLACE`, ce qui
--     préserve OID, propriétaire et ACL ;
--   - elle ne change pas le mode : `strict` reste `false`. Le basculement est
--     une décision d'exploitation. En mode permissif, l'adresse vient toujours
--     du GUC : c'est le comportement antérieur, conservé pour la transition ;
--   - elle n'accorde aucun privilège : ni SUPERUSER, ni BYPASSRLS, ni
--     appartenance, ni GRANT nouveau au runtime.
-- ============================================================================

-- 1. L'ADRESSE, LIÉE À L'IDENTITÉ SIGNÉE --------------------------------------
--    En mode strict, l'adresse n'est plus une déclaration : c'est une LECTURE
--    de `public.users` sur l'identifiant SIGNÉ. `users` est sous RLS FORCE et
--    sa politique filtre sur `tracefab_current_user_id()` : `tracefab_app` ne
--    voit que sa propre ligne (mesuré : 1 ligne avec jeton de A, 0 sans).
--    En mode permissif, rien ne change (`tracefab.user_email`), ce qui préserve
--    la transition : aucune application n'a besoin d'émettre les jetons avant
--    que la base ne les vérifie.
--
--    Reste SECURITY INVOKER, comme avant : la fonction ne donne aucun droit
--    qu'elle ne possédait pas. `search_path` est épinglé et tout est qualifié.
CREATE OR REPLACE FUNCTION public.tracefab_current_user_email()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $email$
  SELECT CASE
           WHEN coalesce((SELECT p.strict FROM public.tracefab_identity_politique p
                           WHERE p.singleton), false)
             THEN (SELECT lower(u.email)
                     FROM public.users u
                    WHERE u.id = public.tracefab_current_user_id())
           ELSE NULLIF(current_setting('tracefab.user_email', true), '')
         END;
$email$;

-- 2. LA POLITIQUE QUI LISAIT LE GUC ------------------------------------------
--    `passport_access_select` comparait `requester_email` au GUC brut, donc à
--    une valeur que l'appelant choisit. Elle passe par la fonction ci-dessus :
--    en mode strict, l'adresse comparée est celle de l'identité signée. Le
--    reste de la politique est inchangé, mot pour mot.
DROP POLICY IF EXISTS passport_access_select ON public.supplier_passport_access_requests;
CREATE POLICY passport_access_select ON public.supplier_passport_access_requests
  FOR SELECT
  USING (
    tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer']::membership_role[])
    OR (requester_organization_id IS NOT NULL AND tracefab_has_org_role(requester_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]))
    OR requester_email = public.tracefab_current_user_email()
  );

-- 3. LA ROTATION DES CLÉS ----------------------------------------------------
--    Une seule clé active : la plus récente. Plusieurs clés actives : TOUTES
--    sont essayées, et la comparaison n'écourte pas la boucle, donc le nombre
--    de clés essayées ne dépend pas du rang de celle qui a signé. Un jeton
--    émis avant une rotation reste accepté tant que son ancienne clé est
--    `actif` — la rotation se fait donc sans coupure, puis l'ancienne clé est
--    désactivée (`actif = false`) après la durée de vie des jetons.
--
--    Ce que cela ne change pas : le jeton ne transporte PAS de numéro de clé,
--    donc aucune information sur la clé n'est divulguée par le format, et un
--    échec reste indistinguable (MAC, date, organisation : même NULL).
CREATE OR REPLACE FUNCTION public.tracefab_identity_jeton_utilisateur(p_jeton TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $verif$
DECLARE
  v_corps   TEXT;
  v_mac     TEXT;
  v_parties TEXT[];
  v_secret  BYTEA;
  v_candidat TEXT;
  v_valide  BOOLEAN := false;
  v_org_guc TEXT;
BEGIN
  IF p_jeton IS NULL OR p_jeton = '' THEN
    RETURN NULL;
  END IF;

  v_corps := split_part(p_jeton, '.', 1);
  v_mac   := split_part(p_jeton, '.', 2);
  v_parties := string_to_array(v_corps, '|');

  -- Forme stricte : 5 champs, version v1, usage attendu.
  IF v_parties IS NULL
     OR array_length(v_parties, 1) <> 5
     OR v_parties[1] <> 'v1'
     OR v_parties[4] <> 'tracefab_identity' THEN
    RETURN NULL;
  END IF;

  -- Expiration : horloge de la BASE, jamais celle de l'appelant.
  IF v_parties[5] !~ '^[0-9]{1,12}$'
     OR v_parties[5]::BIGINT <= extract(epoch FROM pg_catalog.now())::BIGINT THEN
    RETURN NULL;
  END IF;

  -- Liaison au contexte : l'organisation signée doit être celle de la session.
  v_org_guc := coalesce(current_setting('tracefab.active_organization_id', true), '');
  IF v_parties[3] <> v_org_guc THEN
    RETURN NULL;
  END IF;

  -- Rotation : toute clé ACTIVE est essayée, sans sortie anticipée.
  FOR v_secret IN
    SELECT k.secret FROM public.tracefab_identity_cles k WHERE k.actif ORDER BY k.version DESC
  LOOP
    v_candidat := pg_catalog.encode(
      public.hmac(pg_catalog.convert_to(v_corps, 'UTF8'), v_secret, 'sha256'), 'hex');
    IF v_candidat = v_mac THEN
      v_valide := true;
    END IF;
  END LOOP;

  IF NOT v_valide THEN
    RETURN NULL;
  END IF;

  -- L'identité vient du CORPS SIGNÉ, jamais du GUC.
  IF v_parties[2] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN v_parties[2]::UUID;
END
$verif$;

-- 4. L'ATTESTATION DES ÉCRITURES DE MASSE ------------------------------------
--    Les trois fonctions ci-dessous sont reprises de leur définition COURANTE
--    (`pg_get_functiondef` avant application), avec une seule ligne changée :
--      v_user_id UUID := NULLIF(current_setting('tracefab.user_id', true), '')::uuid;
--    devient
--      v_user_id UUID := public.tracefab_current_user_id();
--    `CREATE OR REPLACE` préserve OID, propriétaire (`tracefab_worker` compris)
--    et ACL : rien d'autre ne bouge. La section 5 vérifie qu'il ne reste plus
--    aucune lecture du GUC brut.
CREATE OR REPLACE FUNCTION public.tracefab_register_transaction_certificate(p_tc_number text, p_standard text, p_issuer_name text, p_seller_organization_id uuid, p_buyer_organization_id uuid, p_certified_material_name text, p_total_certified_weight_kg numeric, p_total_certified_meters numeric DEFAULT NULL::numeric, p_issue_date date DEFAULT CURRENT_DATE, p_expiry_date date DEFAULT NULL::date, p_document_id uuid DEFAULT NULL::uuid)
 RETURNS transaction_certificates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID := public.tracefab_current_user_id();  -- P10.6 : identite SIGNEE, jamais le GUC brut
  v_tc transaction_certificates;
BEGIN
  -- Vérifier les habilitations de l'émetteur ou du récepteur
  IF NOT (
    tracefab_has_org_role(p_seller_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    OR tracefab_has_org_role(p_buyer_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  ) THEN
    RAISE EXCEPTION 'access_denied_tc_party_role_required';
  END IF;

  INSERT INTO transaction_certificates (
    tc_number,
    standard,
    issuer_name,
    seller_organization_id,
    buyer_organization_id,
    certified_material_name,
    total_certified_weight_kg,
    total_certified_meters,
    allocated_weight_kg,
    allocated_meters,
    status,
    issue_date,
    expiry_date,
    document_id,
    created_by
  ) VALUES (
    trim(p_tc_number),
    trim(p_standard),
    trim(p_issuer_name),
    p_seller_organization_id,
    p_buyer_organization_id,
    trim(p_certified_material_name),
    p_total_certified_weight_kg,
    p_total_certified_meters,
    0,
    0,
    'active',
    p_issue_date,
    p_expiry_date,
    p_document_id,
    v_user_id
  )
  RETURNING * INTO v_tc;

  RETURN v_tc;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tracefab_allocate_tc_quantity(p_tc_id uuid, p_product_id uuid, p_allocated_weight_kg numeric, p_allocated_meters numeric DEFAULT 0, p_order_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS mass_balance_allocations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID := public.tracefab_current_user_id();  -- P10.6 : identite SIGNEE, jamais le GUC brut
  v_tc transaction_certificates;
  v_product tracefab_products;
  v_alloc mass_balance_allocations;
  v_new_allocated NUMERIC;
BEGIN
  -- 1. Verrouillage du certificat pour empêcher tout double-spending simultané
  SELECT * INTO v_tc
  FROM transaction_certificates
  WHERE id = p_tc_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tc_not_found';
  END IF;

  IF v_tc.status != 'active' THEN
    RAISE EXCEPTION 'tc_not_active_cannot_allocate';
  END IF;

  -- 2. Vérification du produit
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  -- 3. Vérification des habilitations
  IF NOT (
    tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    OR tracefab_has_org_role(v_tc.seller_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  ) THEN
    RAISE EXCEPTION 'access_denied_allocation_role_required';
  END IF;

  -- 4. Contrôle mathématique de non-dépassement (Double-Spending Prevention)
  v_new_allocated := v_tc.allocated_weight_kg + p_allocated_weight_kg;
  IF v_new_allocated > v_tc.total_certified_weight_kg THEN
    RAISE EXCEPTION 'tc_quantity_exceeded_double_spending_prevented: remaining=% kg, requested=% kg',
      (v_tc.total_certified_weight_kg - v_tc.allocated_weight_kg),
      p_allocated_weight_kg;
  END IF;

  -- 5. Création de l'enregistrement d'allocation
  INSERT INTO mass_balance_allocations (
    transaction_certificate_id,
    product_id,
    order_id,
    allocated_weight_kg,
    allocated_meters,
    notes,
    allocated_by
  ) VALUES (
    p_tc_id,
    p_product_id,
    p_order_id,
    p_allocated_weight_kg,
    COALESCE(p_allocated_meters, 0),
    p_notes,
    v_user_id
  )
  RETURNING * INTO v_alloc;

  -- 6. Mise à jour du solde du TC
  UPDATE transaction_certificates
  SET
    allocated_weight_kg = v_new_allocated,
    allocated_meters = allocated_meters + COALESCE(p_allocated_meters, 0),
    status = CASE WHEN v_new_allocated >= total_certified_weight_kg THEN 'exhausted' ELSE 'active' END,
    updated_at = now()
  WHERE id = p_tc_id;

  RETURN v_alloc;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tracefab_reconcile_mass_balance(p_product_id uuid, p_production_volume_units integer, p_cutting_waste_pct numeric DEFAULT 12.00, p_batch_reference text DEFAULT 'SERIE_PRODUCTION_2026'::text)
 RETURNS mass_balance_reconciliations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID := public.tracefab_current_user_id();  -- P10.6 : identite SIGNEE, jamais le GUC brut
  v_product tracefab_products;
  v_unit_weight NUMERIC;
  v_theoretical_kg NUMERIC;
  v_allocated_kg NUMERIC := 0;
  v_coverage_pct NUMERIC;
  v_deficit_kg NUMERIC := 0;
  v_verdict TEXT;
  v_fraud_risk INTEGER;
  v_summary TEXT;
  v_blocking_created BOOLEAN := false;
  v_quality_issue_id UUID := NULL;
  v_rec mass_balance_reconciliations;
BEGIN
  -- 1. Récupération du produit
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]) THEN
    RAISE EXCEPTION 'access_denied_brand_role_required';
  END IF;

  v_unit_weight := COALESCE(v_product.weight_grams, 200.00);

  -- 2. Calcul mathématique du besoin théorique avec coefficient de perte de coupe
  -- besoin_kg = volume_unités * (poids_unitaire_g / 1000) * (1 + perte_coupe / 100)
  v_theoretical_kg := ROUND(
    (p_production_volume_units * (v_unit_weight / 1000.0) * (1.0 + (p_cutting_waste_pct / 100.0))),
    3
  );

  -- 3. Somme de toutes les quantités allouées via des TCs actifs
  SELECT COALESCE(SUM(allocated_weight_kg), 0)
  INTO v_allocated_kg
  FROM mass_balance_allocations
  WHERE product_id = p_product_id;

  -- 4. Ratio de couverture et calcul du déficit
  IF v_theoretical_kg > 0 THEN
    v_coverage_pct := ROUND((v_allocated_kg / v_theoretical_kg) * 100.0, 2);
  ELSE
    v_coverage_pct := 100.0;
  END IF;

  v_deficit_kg := GREATEST(0, v_theoretical_kg - v_allocated_kg);

  -- 5. Machine d'arbitrage et détection de fraude volumétrique
  IF v_allocated_kg = 0 THEN
    v_verdict := 'unsupported';
    v_fraud_risk := 100;
    v_summary := format('Aucun Transaction Certificate (TC) alloué pour %s pièces produites (%s kg requis). Allégation non étayée.', p_production_volume_units, v_theoretical_kg);
  ELSIF v_coverage_pct < 50.0 THEN
    v_verdict := 'severe_deficit';
    v_fraud_risk := 95;
    v_summary := format('Alerte Fraude Volumétrique : Seulement %s kg de matière certifiée couverts sur %s kg requis pour %s pièces (couverture %s%%). Déficit de %s kg.', v_allocated_kg, v_theoretical_kg, p_production_volume_units, v_coverage_pct, v_deficit_kg);
  ELSIF v_coverage_pct < 98.0 THEN
    v_verdict := 'partially_covered';
    v_fraud_risk := 40;
    v_summary := format('Couverture partielle : %s%% du volume requis est couvert par les TCs (%s kg / %s kg). Risque modéré.', v_coverage_pct, v_allocated_kg, v_theoretical_kg);
  ELSE
    v_verdict := 'fully_covered';
    v_fraud_risk := 0;
    v_summary := format('Bilan massique conforme : 100%% des %s pièces produites sont couvertes par des Transaction Certificates vérifiés (%s kg alloués pour %s kg requis).', p_production_volume_units, v_allocated_kg, v_theoretical_kg);
  END IF;

  -- 6. Synchronisation automatique avec le Quality Center & Blocage DPP
  IF v_verdict IN ('severe_deficit', 'unsupported') THEN
    INSERT INTO data_quality_issues (
      owner_organization_id,
      product_id,
      rule_key,
      rule_version,
      severity,
      message,
      status,
      details
    ) VALUES (
      v_product.brand_organization_id,
      p_product_id,
      'mass_balance_severe_deficit',
      '1.0',
      'blocking',
      format('Fraude volumétrique détectée : %s pièces déclarées mais seulement %s%% couvertes par des certificats TC.', p_production_volume_units, v_coverage_pct),
      'open',
      jsonb_build_object(
        'theoreticalKg', v_theoretical_kg,
        'allocatedKg', v_allocated_kg,
        'deficitKg', v_deficit_kg,
        'coverageRatioPct', v_coverage_pct,
        'fraudRiskScore', v_fraud_risk
      )
    )
    RETURNING id INTO v_quality_issue_id;

    v_blocking_created := true;
  ELSE
    -- Résoudre l'anomalie si elle existait précédemment et que le déficit a été comblé
    UPDATE data_quality_issues
    SET
      status = 'resolved',
      resolved_at = now()
    WHERE product_id = p_product_id
      AND rule_key = 'mass_balance_severe_deficit'
      AND status = 'open';
  END IF;

  -- 7. Enregistrement de l'audit bilanciel
  INSERT INTO mass_balance_reconciliations (
    product_id,
    brand_organization_id,
    batch_reference,
    production_volume_units,
    unit_weight_grams,
    cutting_waste_pct,
    theoretical_required_kg,
    allocated_certified_kg,
    deficit_kg,
    coverage_ratio_pct,
    verdict,
    fraud_risk_score,
    summary,
    blocking_issue_created,
    quality_issue_id,
    reconciled_by
  ) VALUES (
    p_product_id,
    v_product.brand_organization_id,
    p_batch_reference,
    p_production_volume_units,
    v_unit_weight,
    p_cutting_waste_pct,
    v_theoretical_kg,
    v_allocated_kg,
    v_deficit_kg,
    v_coverage_pct,
    v_verdict,
    v_fraud_risk,
    v_summary,
    v_blocking_created,
    v_quality_issue_id,
    v_user_id
  )
  RETURNING * INTO v_rec;

  RETURN v_rec;
END;
$function$;
-- 5. POSTCONDITIONS ----------------------------------------------------------
--    Une migration qui remplace des fonctions doit prouver ce qu'elle a laissé
--    derrière elle, sinon une régression silencieuse passerait pour un succès.

DO $garde$
DECLARE
  v_reste TEXT;
BEGIN
  -- 5.1 Plus aucune fonction ne lit le GUC brut d'identité, sauf le point de
  --     passage unique (qui en a besoin pour son mode permissif).
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_reste
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proname <> 'tracefab_current_user_id'
     AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%current_setting(''tracefab.user_id''%';
  IF v_reste IS NOT NULL THEN
    RAISE EXCEPTION 'P10.6 : ces fonctions lisent encore le GUC non signe tracefab.user_id : %', v_reste;
  END IF;

  -- 5.2 Plus aucune politique ne compare au GUC d'adresse.
  SELECT string_agg(policyname, ', ' ORDER BY policyname)
    INTO v_reste
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'public'
     AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%tracefab.user_email%';
  IF v_reste IS NOT NULL THEN
    RAISE EXCEPTION 'P10.6 : ces politiques comparent au GUC non signe tracefab.user_email : %', v_reste;
  END IF;

  -- 5.3 Les trois fonctions d'attestation appellent bien le point de passage.
  SELECT string_agg(nom, ', ' ORDER BY nom)
    INTO v_reste
    FROM unnest(ARRAY[
      'tracefab_register_transaction_certificate',
      'tracefab_allocate_tc_quantity',
      'tracefab_reconcile_mass_balance']) AS nom
   WHERE pg_catalog.pg_get_functiondef(
           ('public.' || nom || CASE nom
              WHEN 'tracefab_register_transaction_certificate' THEN '(text,text,text,uuid,uuid,text,numeric,numeric,date,date,uuid)'
              WHEN 'tracefab_allocate_tc_quantity' THEN '(uuid,uuid,numeric,numeric,uuid,text)'
              ELSE '(uuid,integer,numeric,text)' END)::regprocedure)
         NOT LIKE '%tracefab_current_user_id()%';
  IF v_reste IS NOT NULL THEN
    RAISE EXCEPTION 'P10.6 : ces fonctions n''utilisent pas l''identite signee : %', v_reste;
  END IF;

  -- 5.4 Le runtime ne doit toujours rien pouvoir lire de la table des clés, et
  --     doit toujours pouvoir vérifier un jeton.
  IF pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_identity_cles', 'SELECT') THEN
    RAISE EXCEPTION 'P10.6 : tracefab_app peut lire les cles d''identite';
  END IF;
  IF pg_catalog.has_function_privilege('tracefab_app', 'public.tracefab_identity_jeton_utilisateur(text)', 'EXECUTE') = false THEN
    RAISE EXCEPTION 'P10.6 : tracefab_app ne peut plus verifier les jetons';
  END IF;
END
$garde$;
