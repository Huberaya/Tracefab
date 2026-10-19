-- Restreindre le DML du role applicatif aux tables réellement écrites en direct.
--
-- ORIGINE DU PROBLEME, mesurée et non supposée.
--
-- La migration 20261014130000_revoke_public_schema_privileges contient un bloc
-- $preserve_runtime_acl$ qui, AVANT de révoquer les privilèges relationnels de
-- PUBLIC, les recopie explicitement sur tracefab_app :
--
--     IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
--       ... EXECUTE format('GRANT %s ON TABLE %s TO tracefab_app', ...);
--
-- Cette préservation était justifiée à l'époque : le runtime tournait avec ce
-- rôle et il ne fallait pas casser les routes en révoquant PUBLIC. Mais seize
-- tables avaient reçu, dans les migrations antérieures, un
-- « GRANT SELECT, INSERT, UPDATE[, DELETE] ... TO PUBLIC » — organizations,
-- suppliers, product_identifiers, plm_erp_integrations, product_pef_assessments,
-- product_green_claims, green_claims_audits, quality_cap_messages,
-- quality_corrective_action_plans, supplier_universal_passports,
-- supplier_passport_access_requests, transaction_certificates,
-- mass_balance_allocations, mass_balance_reconciliations,
-- rate_limit_counters, tracefab_catalog_import_jobs.
--
-- Le transfert les a donc toutes reportées sur le rôle applicatif. Mesure sur
-- base reconstruite depuis les 49 migrations, avec le rôle présent avant les
-- migrations — c'est-à-dire l'ordre réel de la CI et de Production :
--
--     entrees ACL PUBLIC sur les tables            : 0
--     tables portant du DML explicite pour l'app   : 36
--
-- PUBLIC est donc propre ; l'excès est entièrement sur tracefab_app.
--
-- ETAT CIBLE. Le runtime n'écrit en SQL brut que quatre tables. Vérification :
-- intersection des « INSERT INTO | UPDATE | DELETE FROM » présents dans api/
-- avec les 50 noms de tables réellement créés par les migrations.
--
--     audit_logs                    api/_routes/catalog/{products,suppliers}/import.ts
--     documents                     api/_lib/documents.ts:107
--     rate_limit_counters           api/_lib/rate-limit.ts:403,415
--     tracefab_catalog_import_jobs  api/_routes/catalog/{products,suppliers}/import.ts
--
-- Aucun appel prisma.<modele>.(create|update|delete|upsert|deleteMany) n'existe
-- dans api/ : toutes les autres écritures passent par des fonctions
-- SECURITY DEFINER, qui s'exécutent avec les droits de leur propriétaire et
-- n'ont donc pas besoin des privilèges de table du rôle appelant.
--
-- Cette migration ne supprime aucun objet, ne touche aucune politique RLS et ne
-- modifie aucune fonction. Elle ne retire que des privilèges de table.

DO $restreindre_dml_app$
DECLARE
  r RECORD;
  tables_conservees CONSTANT text[] := ARRAY[
    'audit_logs',
    'documents',
    'rate_limit_counters',
    'tracefab_catalog_import_jobs'
  ];
BEGIN
  -- Sans le rôle, il n'y a rien à restreindre : la migration reste un no-op
  -- plutôt que d'échouer. C'est le cas d'une base où le bootstrap n'a pas
  -- encore tourné.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    RAISE NOTICE 'role tracefab_app absent : restriction du DML ignoree';
    RETURN;
  END IF;

  -- 1. Retirer le DML partout sauf sur les quatre tables approuvées.
  --    Le SELECT est conservé : la lecture générale reste filtrée par la RLS,
  --    active et forcée sur les 50 tables.
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname <> ALL (tables_conservees)
      AND c.relname <> '_prisma_migrations'
  LOOP
    -- Le mot-cle TABLE ne doit pas passer par %I : format() le quoterait en
    -- identifiant et PostgreSQL leverait 42601. Seuls les noms de tables sont
    -- quotes.
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %I FROM tracefab_app',
      r.relname
    );
  END LOOP;

  -- 2. Réaccorder explicitement les quatre tables. Fait ici et non seulement
  --    dans le bootstrap, pour que l'état cible soit atteint quel que soit
  --    l'ordre bootstrap/migrations — c'est précisément l'ordre qui produisait
  --    la divergence mesurée.
  EXECUTE format(
    'GRANT INSERT, UPDATE, DELETE ON TABLE %I, %I, %I, %I TO tracefab_app',
    tables_conservees[1], tables_conservees[2], tables_conservees[3], tables_conservees[4]
  );

  -- 3. Filet défensif sur PUBLIC. Mesuré à zéro aujourd'hui : cette boucle est
  --    un no-op sur l'état courant. Elle existe parce que rien n'empêche une
  --    migration future de réaccorder du DML à PUBLIC, et que le bloc
  --    $preserve_runtime_acl$ le reporterait alors silencieusement sur le rôle
  --    applicatif. Ne retire que du DML, jamais le SELECT.
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm')
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %I FROM PUBLIC',
      r.relname
    );
  END LOOP;
END
$restreindre_dml_app$;

-- 4. Aucune table créée à l'avenir ne doit donner implicitement le droit
--    d'écrire au runtime. Aligné sur le bootstrap : le défaut est la lecture.
--    L'écriture directe sur une table nouvelle exige une décision explicite.
DO $defauts_lecture_seule$
DECLARE
  proprio text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    RETURN;
  END IF;

  SELECT rolname INTO proprio
  FROM pg_roles
  WHERE oid = (SELECT relowner FROM pg_class WHERE relname = 'organizations'
               AND relnamespace = 'public'::regnamespace)
  LIMIT 1;

  IF proprio IS NULL THEN
    RAISE NOTICE 'proprietaire des tables introuvable : privileges par defaut non modifies';
    RETURN;
  END IF;

  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO tracefab_app',
    proprio
  );
END
$defauts_lecture_seule$;
