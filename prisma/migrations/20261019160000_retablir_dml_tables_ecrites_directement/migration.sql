-- Rétablir le DML du rôle applicatif sur les tables qu'il écrit réellement.
--
-- CORRECTIF DE 20261019120000_restreindre_dml_role_applicatif.
--
-- Cette migration précédente partait d'un constat exact mais d'une mesure
-- incomplète. Elle écrit, ligne 33 : « intersection des « INSERT INTO |
-- UPDATE | DELETE FROM » présents dans api/ avec les 50 noms de tables ».
-- Ce filtre ne retient que le SQL écrit en clair ($executeRaw / $queryRaw).
-- Il laisse dehors TOUTES les écritures faites par méthode de modèle Prisma,
-- qui sont la forme dominante dans ce dépôt :
--
--     tx.user.upsert({ ... })            -> INSERT/UPDATE sur users
--     prisma.data_points.create({ ... }) -> INSERT sur data_points
--     .supply_chain_links.deleteMany(...)  -> DELETE sur supply_chain_links
--
-- Résultat mesuré le 19 octobre sur base reconstruite depuis les 51 migrations :
-- l'application écrit directement 21 tables, pas 4. Les 17 ci-dessous étaient
-- donc privées d'écriture à tort.
--
-- Conséquence si l'on ne corrige pas : dès que le runtime se connecte sous
-- tracefab_app, ces chemins reçoivent 42501 (permission denied). Le premier
-- touché est le provisionnement Clerk — api/_lib/auth.ts:37 et les quatre
-- sites de api/_routes/webhooks/clerk.ts — donc plus aucune session ne peut
-- être provisionnée. `withTracefabWorkerContext` ne change pas le rôle : il
-- pose un GUC transactionnel (set_config('tracefab.worker_context', ...)), et
-- un GUC n'accorde aucun privilège relationnel.
--
-- Preuve que le défaut est réel et non théorique, mesurée sur base jetable :
-- le contrôle existant test_rls_bypass_controle_negatif.mjs exécute
-- « UPDATE tracefab_products » sous le rôle applicatif. Il passe à 49
-- migrations et tombe à 51 avec 42501 permission denied for table
-- tracefab_products. Ce contrôle fait partie du job CI requis
-- « Base — isolation RLS executee ».
--
-- Ce qui n'est PAS rendu : les 29 tables que l'application n'écrit jamais en
-- direct restent en lecture seule pour le rôle, et les tables DPP append-only
-- gardent leur révocation (20261017120000_harden_dpp_table_privileges) —
-- aucune table dpp_* ne figure ci-dessous. Le durcissement reste donc réel :
-- 36 tables avaient du DML avant le chantier, 21 en ont après.
--
-- Tables rétablies, avec le premier site d'écriture constaté dans api/ :
--     data_points                      api/_routes/products/[productId]/data-points.ts:77
--     data_shares                      api/_routes/supplier/shares.ts:67
--     materials                        api/_lib/bulk-operations/bulk-importer.ts:178
--     organization_invitations         api/_routes/supplier/member-invitations/[invitationId].ts:47
--     organization_memberships         api/_routes/supplier/members.ts:148
--     organizations                    api/_routes/organizations.ts:66
--     plm_erp_integrations             api/_routes/integrations.ts:55
--     plm_erp_sync_jobs                api/_lib/bulk-operations/bulk-importer.ts:223
--     product_green_claims             api/_routes/products/[productId]/green-claims.ts:47
--     product_identifiers              api/_lib/bulk-operations/bulk-importer.ts:143
--     product_materials                api/_lib/bulk-operations/bulk-importer.ts:191
--     quality_cap_messages             api/_routes/quality/caps/[capId]/messages.ts:64
--     supplier_sites                   api/_routes/supplier/sites/[siteId].ts:32
--     supply_chain_links               api/_routes/products/[productId]/supply-chain/links/[linkId].ts:45
--     supply_chain_nodes               api/_routes/products/[productId]/supply-chain/nodes/[nodeId].ts:52
--     tracefab_products                api/_lib/bulk-operations/bulk-importer.ts:97
--     users                            api/_lib/auth.ts:37
--
-- La liste complète et sa méthode de dérivation vivent dans
-- scripts/lib/tracefab_app_role.mjs. Elle est re-dérivée et comparée par
-- scripts/test_tables_ecriture_directe.mjs, qui échoue si le code applicatif
-- écrit une table que le rôle ne peut pas écrire. C'est la garde qui manquait
-- et qui a laissé passer cette erreur.
--
-- Idempotent : rejouer ne fait que ré-accorder les mêmes privilèges.

DO $correctif_dml$
DECLARE
  tables_a_rendre text[] := ARRAY[
    'data_points',
    'data_shares',
    'materials',
    'organization_invitations',
    'organization_memberships',
    'organizations',
    'plm_erp_integrations',
    'plm_erp_sync_jobs',
    'product_green_claims',
    'product_identifiers',
    'product_materials',
    'quality_cap_messages',
    'supplier_sites',
    'supply_chain_links',
    'supply_chain_nodes',
    'tracefab_products',
    'users'
  ];
  t text;
  rendues int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    RAISE NOTICE 'tracefab_app absent : rien a accorder (base vierge, le bootstrap le fera)';
    RETURN;
  END IF;

  FOREACH t IN ARRAY tables_a_rendre LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE WARNING 'table % absente : octroi saute', t;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON TABLE %I TO tracefab_app', t);
    rendues := rendues + 1;
  END LOOP;

  RAISE NOTICE 'DML retabli sur % table(s) pour tracefab_app', rendues;
END
$correctif_dml$;
