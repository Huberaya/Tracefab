-- Réconciliation forward-only du catalogue PLM/ERP et des identifiants GS1.
-- La migration historique 20261006210000 est checksum-divergente ; la lecture
-- Neon du 04/11 a montré que les quatre CHECK de plm_erp_integrations manquent
-- et que product_identifiers n'accepte pas encore GPC. Ne pas réécrire l'ancien SQL.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_count integer;
  v_invalid bigint;
  v_definition text;
  v_old_identifier_check constant text :=
    'CHECK ((identifier_type = ANY (ARRAY[''gtin''::text, ''ean''::text, ''upc''::text, ''internal''::text, ''gs1_digital_link''::text, ''gln''::text])))';
  v_new_identifier_check constant text :=
    'CHECK ((identifier_type = ANY (ARRAY[''gtin''::text, ''ean''::text, ''upc''::text, ''internal''::text, ''gs1_digital_link''::text, ''gln''::text, ''gpc''::text])))';
BEGIN
  IF to_regclass('public.plm_erp_integrations') IS NULL THEN
    RAISE EXCEPTION 'plm_integrations_table_missing';
  END IF;

  IF to_regclass('public.product_identifiers') IS NULL THEN
    RAISE EXCEPTION 'product_identifiers_table_missing';
  END IF;

  -- Précondition : les valeurs existantes doivent satisfaire le contrat cible.
  SELECT count(*) INTO v_invalid
  FROM public.plm_erp_integrations
  WHERE system_type IS NULL
     OR system_type NOT IN ('centric_plm', 'lectra_kubix', 'sap_s4hana', 'infor_fashion', 'gs1_epcis', 'generic_csv')
     OR name IS NULL
     OR length(trim(name)) = 0
     OR auth_type IS NULL
     OR auth_type NOT IN ('api_key', 'bearer_token', 'oauth2', 'webhook', 'manual_import')
     OR status IS NULL
     OR status NOT IN ('active', 'inactive', 'syncing', 'error');

  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'plm_integrations_invalid_existing_rows: %', v_invalid;
  END IF;

  SELECT count(*) INTO v_invalid
  FROM public.product_identifiers
  WHERE identifier_type IS NULL
     OR identifier_type NOT IN ('gtin', 'ean', 'upc', 'internal', 'gs1_digital_link', 'gln', 'gpc');

  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'product_identifiers_invalid_existing_rows: %', v_invalid;
  END IF;

  -- Les quatre contraintes PLM sont soit toutes absentes (état Neon mesuré),
  -- soit toutes présentes et conformes. Un état partiel est refusé.
  SELECT count(*) INTO v_count
  FROM pg_constraint
  WHERE conrelid = 'public.plm_erp_integrations'::regclass
    AND conname IN (
      'plm_erp_integrations_system_type_check',
      'plm_erp_integrations_name_check',
      'plm_erp_integrations_auth_type_check',
      'plm_erp_integrations_status_check'
    );

  IF v_count = 0 THEN
    ALTER TABLE public.plm_erp_integrations
      ADD CONSTRAINT plm_erp_integrations_system_type_check
      CHECK (system_type IN ('centric_plm', 'lectra_kubix', 'sap_s4hana', 'infor_fashion', 'gs1_epcis', 'generic_csv')) NOT VALID;
    ALTER TABLE public.plm_erp_integrations
      VALIDATE CONSTRAINT plm_erp_integrations_system_type_check;

    ALTER TABLE public.plm_erp_integrations
      ADD CONSTRAINT plm_erp_integrations_name_check
      CHECK (length(trim(name)) > 0) NOT VALID;
    ALTER TABLE public.plm_erp_integrations
      VALIDATE CONSTRAINT plm_erp_integrations_name_check;

    ALTER TABLE public.plm_erp_integrations
      ADD CONSTRAINT plm_erp_integrations_auth_type_check
      CHECK (auth_type IN ('api_key', 'bearer_token', 'oauth2', 'webhook', 'manual_import')) NOT VALID;
    ALTER TABLE public.plm_erp_integrations
      VALIDATE CONSTRAINT plm_erp_integrations_auth_type_check;

    ALTER TABLE public.plm_erp_integrations
      ADD CONSTRAINT plm_erp_integrations_status_check
      CHECK (status IN ('active', 'inactive', 'syncing', 'error')) NOT VALID;
    ALTER TABLE public.plm_erp_integrations
      VALIDATE CONSTRAINT plm_erp_integrations_status_check;
  ELSIF v_count = 4 THEN
    SELECT pg_get_constraintdef(oid) INTO v_definition
    FROM pg_constraint
    WHERE conrelid = 'public.plm_erp_integrations'::regclass
      AND conname = 'plm_erp_integrations_system_type_check';
    IF v_definition IS NULL OR v_definition NOT LIKE '%centric_plm%'
       OR v_definition NOT LIKE '%lectra_kubix%' OR v_definition NOT LIKE '%sap_s4hana%'
       OR v_definition NOT LIKE '%infor_fashion%' OR v_definition NOT LIKE '%gs1_epcis%'
       OR v_definition NOT LIKE '%generic_csv%' THEN
      RAISE EXCEPTION 'plm_integrations_system_type_check_unexpected: %', v_definition;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_definition
    FROM pg_constraint
    WHERE conrelid = 'public.plm_erp_integrations'::regclass
      AND conname = 'plm_erp_integrations_name_check';
    IF v_definition IS NULL OR v_definition NOT LIKE '%length%'
       OR v_definition NOT LIKE '%name%' OR v_definition NOT LIKE '%> 0%' THEN
      RAISE EXCEPTION 'plm_integrations_name_check_unexpected: %', v_definition;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_definition
    FROM pg_constraint
    WHERE conrelid = 'public.plm_erp_integrations'::regclass
      AND conname = 'plm_erp_integrations_auth_type_check';
    IF v_definition IS NULL OR v_definition NOT LIKE '%api_key%'
       OR v_definition NOT LIKE '%bearer_token%' OR v_definition NOT LIKE '%oauth2%'
       OR v_definition NOT LIKE '%webhook%' OR v_definition NOT LIKE '%manual_import%' THEN
      RAISE EXCEPTION 'plm_integrations_auth_type_check_unexpected: %', v_definition;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_definition
    FROM pg_constraint
    WHERE conrelid = 'public.plm_erp_integrations'::regclass
      AND conname = 'plm_erp_integrations_status_check';
    IF v_definition IS NULL OR v_definition NOT LIKE '%active%'
       OR v_definition NOT LIKE '%inactive%' OR v_definition NOT LIKE '%syncing%'
       OR v_definition NOT LIKE '%error%' THEN
      RAISE EXCEPTION 'plm_integrations_status_check_unexpected: %', v_definition;
    END IF;
  ELSE
    RAISE EXCEPTION 'plm_integrations_partial_check_constraints: %/4', v_count;
  END IF;

  -- Le catalogue mesuré porte l'ancienne contrainte exacte sans GPC. On
  -- accepte aussi la version cible pour rendre cette migration idempotente ;
  -- toute autre définition est un refus explicite.
  SELECT pg_get_constraintdef(oid) INTO v_definition
  FROM pg_constraint
  WHERE conrelid = 'public.product_identifiers'::regclass
    AND conname = 'product_identifiers_identifier_type_check';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'product_identifier_type_check_missing';
  ELSIF v_definition = v_old_identifier_check THEN
    ALTER TABLE public.product_identifiers
      DROP CONSTRAINT product_identifiers_identifier_type_check;
    ALTER TABLE public.product_identifiers
      ADD CONSTRAINT product_identifiers_identifier_type_check
      CHECK (identifier_type IN ('gtin', 'ean', 'upc', 'internal', 'gs1_digital_link', 'gln', 'gpc')) NOT VALID;
    ALTER TABLE public.product_identifiers
      VALIDATE CONSTRAINT product_identifiers_identifier_type_check;
  ELSIF v_definition <> v_new_identifier_check THEN
    RAISE EXCEPTION 'product_identifier_type_check_unexpected: %', v_definition;
  END IF;
END $$;

COMMIT;
