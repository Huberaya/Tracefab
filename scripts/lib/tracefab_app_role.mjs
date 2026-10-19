/**
 * Creation etablie du role applicatif `tracefab_app`.
 *
 * POURQUOI CE MODULE
 *
 * La chaine de migrations reference le role `tracefab_app` (les GRANT EXECUTE
 * de 20261009180000_public_read_context). Or le role est une donnee
 * d'infrastructure : il existe en production, mais pas sur une base vierge ou
 * il n'etait cree qu'APRES les migrations (scripts/seed_rls_fixture.mjs).
 * Resultat verifie sur base neuve : « role "tracefab_app" does not exist »
 * (SQLSTATE 42704), toute la chaine s'arrete, la CI ne teste plus rien.
 *
 * La correction est de poser le role AVANT les migrations — pas de
 * contourner les GRANT en les supprimant. Les deux ordres restent valides :
 *   - base vierge : bootstrap_app_role -> migrations (les GRANT s'exercent) ;
 *   - base existante sans le role : les GRANT proteges par IF EXISTS
 *     sautent, et ce module + le seed re-accordent ensuite.
 *
 * Le role est sans BYPASSRLS et sans le moindre privilege d'administration :
 * c'est lui qui servira les requetes applicatives, et les politiques RLS
 * doivent donc etre reellement evaluees pour lui.
 */
import pg from 'pg';
import { sslDepuisUrl } from './pg-ssl.mjs';

/** Constante partagee : le nom du role applicatif. */
export const APP_ROLE = 'tracefab_app';

// Tables que le runtime ecrit DIRECTEMENT, hors fonctions SECURITY DEFINER.
//
// CORRECTION DU 19 OCTOBRE — cette liste valait 4 tables et elle etait FAUSSE.
// L'extraction precedente ne relevait que les ordres SQL ecrits en clair
// ($executeRaw / $queryRaw) et passait a cote de TOUTES les ecritures faites
// par methodes de modele Prisma (`tx.user.upsert(...)`, `documents.create(...)`).
// Resultat mesure : 21 tables sont ecrites directement, pas 4. En restreignant
// le role a 4 tables, on cassait 17 chemins applicatifs des que le runtime
// tourne sous tracefab_app — dont le provisionnement Clerk (users, 5 sites) et
// les webhooks. `withTracefabWorkerContext` ne pose qu'un GUC transactionnel
// (set_config('tracefab.worker_context', ...)), il ne fait PAS de SET ROLE :
// l'ecriture s'execute donc sous le role de connexion et recoit 42501.
//
// Methode de la liste ci-dessous : extraction des methodes d'ecriture Prisma
// ET des ordres SQL d'ecriture de api/, filtree sur les tables reellement
// presentes en base (certaines n'ont aucun modele Prisma, comme
// tracefab_catalog_import_jobs). Reproductible par
// `npm run test:tables-ecriture-directe`, qui rederive la liste et echoue si
// elle diverge de celle-ci ou des privileges reels. Ne pas l'editer a la main.
//
//   audit_logs                    api/_lib/audit-vault.ts:65                           (audit_logs.create, insert)
//   data_points                   api/_routes/products/[productId]/data-points.ts:77   (data_points.create)
//   data_shares                   api/_routes/supplier/shares.ts:67                    (data_shares.create)
//   documents                     api/_lib/documents.ts:107                            (update)
//   materials                     api/_lib/bulk-operations/bulk-importer.ts:178        (materials.create)
//   organization_invitations      api/_routes/supplier/member-invitations/[invitationId].ts:47 (organization_invitations.create, organization_invitations.update)
//   organization_memberships      api/_routes/supplier/members.ts:148                  (organization_memberships.update, organization_memberships.updatemany)
//   organizations                 api/_routes/organizations.ts:66                      (organizations.update)
//   plm_erp_integrations          api/_routes/integrations.ts:55                       (plm_erp_integrations.upsert)
//   plm_erp_sync_jobs             api/_lib/bulk-operations/bulk-importer.ts:223        (plm_erp_sync_jobs.create)
//   product_green_claims          api/_routes/products/[productId]/green-claims.ts:47  (product_green_claims.create)
//   product_identifiers           api/_lib/bulk-operations/bulk-importer.ts:143        (product_identifiers.upsert)
//   product_materials             api/_lib/bulk-operations/bulk-importer.ts:191        (product_materials.upsert)
//   quality_cap_messages          api/_routes/quality/caps/[capId]/messages.ts:64      (quality_cap_messages.create)
//   rate_limit_counters           api/_lib/rate-limit.ts:403                           (delete, insert)
//   supplier_sites                api/_routes/supplier/sites/[siteId].ts:32            (supplier_sites.create, supplier_sites.update)
//   supply_chain_links            api/_routes/products/[productId]/supply-chain/links/[linkId].ts:45 (supply_chain_links.deletemany)
//   supply_chain_nodes            api/_routes/products/[productId]/supply-chain/nodes/[nodeId].ts:52 (supply_chain_nodes.deletemany)
//   tracefab_catalog_import_jobs  api/_routes/catalog/products/import.ts:138           (insert, update)
//   tracefab_products             api/_lib/bulk-operations/bulk-importer.ts:97         (tracefab_products.create, tracefab_products.update)
//   users                         api/_lib/auth.ts:37                                  (user.updatemany, user.upsert)
//
// Retirer une table d'ici exige d'avoir d'abord deplace son chemin applicatif
// vers une fonction SECURITY DEFINER. Le controle
// scripts/test_privileges_role_app.mjs echoue si un octroi global reapparait.
export const TABLES_ECRITURE_DIRECTE = [
  'audit_logs',
  'data_points',
  'data_shares',
  'documents',
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
  'rate_limit_counters',
  'supplier_sites',
  'supply_chain_links',
  'supply_chain_nodes',
  'tracefab_catalog_import_jobs',
  'tracefab_products',
  'users',
];

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Cree (ou reaffirme) le role applicatif et ses droits par defaut.
 *
 * Idempotent : relancer ne duplique ni ne casse rien. Doit etre appelee
 * avant `prisma migrate deploy` sur une base vierge, et reste sans effet
 * dommageable sur une base ou le role existe deja.
 *
 * @param {pg.Client} db connexion proprietaire de la base
 * @param {string} password mot de passe du role applicatif
 */
export async function ensureAppRole(db, password) {
  const existe = await db.query('select 1 from pg_roles where rolname = $1', [APP_ROLE]);
  if (existe.rowCount === 0) {
    await db.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD ${quote(password)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`);
    console.log(`  role ${APP_ROLE} cree (sans BYPASSRLS)`);
  } else {
    await db.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${quote(password)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`);
    console.log(`  role ${APP_ROLE} deja present, attributs reaffirmes (sans BYPASSRLS)`);
  }

  const base = (await db.query('select current_database() d')).rows[0].d;
  const proprio = (await db.query('select current_user u')).rows[0].u;

  // Liste des tables en ecriture directe : voir TABLES_ECRITURE_DIRECTE,
  // exportee au niveau module (source unique, importee par les controles).
  const listeEcriture = TABLES_ECRITURE_DIRECTE.join(', ');

  for (const sql of [
    `GRANT CONNECT ON DATABASE "${base}" TO ${APP_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
    // LECTURE sur toutes les tables : le client Prisma lit directement, et la
    // RLS — activee et forcee sur les 50 tables — filtre ce qui est visible.
    // La lecture large est donc contenue ; l'ecriture large ne l'etait pas.
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    // ECRITURE sur les seules tables que le runtime touche hors fonction.
    // Auparavant : GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES, ce qui
    // rendait toute table modifiable directement et vidait de son sens le
    // principe « mutations par fonctions ». Conditionnel : au bootstrap d'une
    // base vierge ces tables n'existent pas encore.
    `DO $$ BEGIN
       IF to_regclass('public.rate_limit_counters') IS NOT NULL THEN
         EXECUTE 'GRANT INSERT, UPDATE, DELETE ON ${listeEcriture} TO ${APP_ROLE}';
       END IF;
     END $$;`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`,
    // EXECUTE sur toutes les fonctions : 74 fonctions appelees par le runtime
    // ont ete verifiees une a une, toutes necessaires. Restreindre ici sans
    // inventaire casserait des chemins applicatifs — et les fonctions portent
    // deja leurs propres REVOKE quand elles ne sont pas publiques.
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`,
    // Droits par defaut pour tout objet FUTUR. Volontairement limites a la
    // lecture : une migration qui cree une table ne doit pas donner
    // silencieusement au runtime le droit d'y ecrire. L'ecriture directe sur
    // une table nouvelle exige une decision explicite.
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT SELECT ON TABLES TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${APP_ROLE}`,
  ]) {
    await db.query(sql);
  }
  // TF-3 — tables DPP append-only : les mutations passent UNIQUEMENT par les
  // fonctions SECURITY DEFINER (tracefab_add_dpp_event, tracefab_add_dpp_claim,
  // tracefab_link_dpp_claim_evidence, tracefab_create/replace_dpp_identity).
  //
  // Ce bloc reste utile alors meme que l'octroi global a ete supprime : sur une
  // base provisionnee sous l'ancienne regle, le role applicatif porte encore
  // INSERT, UPDATE et DELETE sur ces quatre tables. Le bloc les retire, donc il
  // corrige aussi l'existant et pas seulement une base neuve. Aligne sur la
  // migration 20261017120000_harden_dpp_table_privileges.
  await db.query(`
    DO $$
    BEGIN
      IF to_regclass('public.dpp_lifecycle_events') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON dpp_lifecycle_events, dpp_claims, dpp_claim_evidence, dpp_resolvable_identifiers FROM PUBLIC';
        EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON dpp_lifecycle_events, dpp_claims, dpp_claim_evidence, dpp_resolvable_identifiers FROM ${APP_ROLE}';
        EXECUTE 'GRANT SELECT ON dpp_lifecycle_events, dpp_claims, dpp_claim_evidence, dpp_resolvable_identifiers TO ${APP_ROLE}';
      END IF;
    END
    $$;
  `);
  console.log(
    `  droits applicatifs accordes a ${APP_ROLE} ` +
    `(lecture generale filtree par RLS ; ecriture directe limitee a ${TABLES_ECRITURE_DIRECTE.length} tables ; ` +
    `le reste des mutations par fonctions SECURITY DEFINER)`,
  );
}

/**
 * Convenience : connexion au proprio puis ensureAppRole.
 * @param {string} urlProprio DATABASE_URL (proprietaire)
 * @param {string} password mot de passe du role applicatif
 */
export async function ensureAppRoleFromUrl(urlProprio, password) {
  const db = new pg.Client({
    connectionString: urlProprio,
    // Validation du certificat toujours active. Un magasin d'autorités
    // supplémentaire se fournit par NODE_EXTRA_CA_CERTS, jamais en désactivant
    // la vérification : voir scripts/lib/pg-ssl.mjs.
    ssl: sslDepuisUrl(urlProprio),
  });
  await db.connect();
  try {
    await ensureAppRole(db, password);
  } finally {
    await db.end();
  }
}
