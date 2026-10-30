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
//   tracefab_catalog_import_jobs  api/_routes/catalog/products/import.ts:138           (insert, update)
//   tracefab_products             api/_lib/bulk-operations/bulk-importer.ts:97         (tracefab_products.create, tracefab_products.update)
//   users                         RETIREE le 28/10/2026 — les ecritures passent
//                                 desormais par tracefab_upsert_clerk_user et
//                                 tracefab_ensure_clerk_user, possedees par
//                                 tracefab_worker et declarees au registre
//                                 runtime. Aucune ecriture directe ne subsiste
//                                 dans api/ (verifie par
//                                 test:tables-ecriture-directe).
//   documents                     RETIREE le 28/10/2026 — la bascule
//                                 `uploaded -> scanning` passait par un UPDATE
//                                 brut sous tracefab_app, qui pouvait poser
//                                 tracefab.internal_document_update et ecrire
//                                 ainsi status/sha256/available_at. Elle passe
//                                 desormais par tracefab_mark_document_scanning,
//                                 declaree au registre runtime. Le role
//                                 applicatif ne garde que SELECT sur documents.
//
// Retirer une table d'ici exige d'avoir d'abord deplace son chemin applicatif
// vers une fonction SECURITY DEFINER. Le controle
// scripts/test_privileges_role_app.mjs echoue si un octroi global reapparait.
export const TABLES_ECRITURE_DIRECTE = [
  'audit_logs',
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
  'rate_limit_counters',
  'supplier_sites',
  'tracefab_catalog_import_jobs',
];

/**
 * Colonnes de `tracefab_products` que le runtime ecrit directement.
 *
 * `tracefab_products` n'est PLUS dans TABLES_ECRITURE_DIRECTE : le role
 * applicatif n'a plus l'ecriture au niveau table, mais colonne par colonne.
 * Les quatre colonnes calculees — version, data_completion, data_readiness,
 * data_ready_at — sont absentes de cette liste, et c'est tout l'objet de la
 * migration 20261028130000 : leur ecriture passait par un GUC de session que
 * n'importe quel role pouvait poser. Elles ne sont desormais accessibles que
 * par les fonctions SECURITY DEFINER (create, update_product_data,
 * start_product_revision, set_dpp_publication, ingest_plm_erp_payload).
 *
 * Mesure du banc, role `tracefab_app` sans BYPASSRLS : `SET version` refuse
 * (42501) avec ET sans le GUC forge ; `SET name` accepte ; INSERT accepte ;
 * `tracefab_start_product_revision` accepte.
 */
export const TABLES_ECRITURE_COLONNES = ['tracefab_products'];

/**
 * Colonnes calculees, hors de portee du role runtime quel que soit le chemin.
 * Verifiees par la garde statique et par test:neon:produit-champs-calcules.
 */
export const COLONNES_CALCULEES_PRODUIT = [
  'version',
  'data_completion',
  'data_readiness',
  'data_ready_at',
];

export const COLONNES_ECRITURE_PRODUIT = [
  'id',
  'brand_organization_id',
  'reference',
  'sku',
  'name',
  'category',
  'status',
  'public_slug',
  'created_by',
  'created_at',
  'updated_at',
  'description',
  'product_family',
  'color_name',
  'size_range',
  'country_of_design',
  'country_of_manufacture',
  'weight_grams',
  'care_instructions',
  'last_data_updated_by',
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
/**
 * Provisioning du role : idempotent ET robuste aux provisions simultanees.
 *
 * Deux executions paralleles qui visent le MEME cluster modifient la meme ligne
 * de `pg_authid` : PostgreSQL repond alors XX000 `tuple concurrently updated`
 * (mesure du 30/10 sur PG 17.10 : 1 execution sur 3 en echouait, sur
 * `ALTER ROLE`). Le role etant un objet de CLUSTER, ce n'est pas la base
 * jetable qui est en cause.
 *
 * Les deux instructions sont idempotentes par nature (CREATE si absent,
 * ALTER sinon), donc les reprendre est sur. `42710` (role cree par l'autre
 * execution entre la lecture et le CREATE) bascule sur ALTER au lieu d'echouer.
 */
const REPRISE_ROLE = { tentatives: 6 };

async function provoquerRole(db, sqlCreate, sqlAlter, etiquette) {
  for (let i = 1; ; i += 1) {
    try {
      await db.query(etiquette === 'creation' ? sqlCreate : sqlAlter);
      return;
    } catch (e) {
      const collision = e.code === '42710' || e.code === '42P04';
      if (collision) { etiquette = 'alter'; continue; }
      if (e.code !== 'XX000' || i >= REPRISE_ROLE.tentatives) throw e;
      // `tuple concurrently updated` : l'autre execution a modifie la ligne
      // entre-temps. Attente courte et croissante, puis reprise.
      await new Promise((r) => setTimeout(r, 20 * i + Math.floor(Math.random() * 30)));
    }
  }
}

/**
 * Refus de provisioning : un role preexistant n'est PAS « le notre ».
 *
 * Ce n'est pas une panne, c'est une decision : on n'ecrit pas sur un role
 * qu'on n'a pas cree et dont on ne peut pas prouver la nature. Les appelants
 * doivent echouer bruyamment plutot que de reecrire un mot de passe.
 */
export class RolePreexistantRefuse extends Error {
  constructor(nom, raisons) {
    super(`role ${nom} preexistant REFUSE : ${raisons.join(' ; ')} — aucune modification`);
    this.name = 'RolePreexistantRefuse';
    this.code = 'TF_ROLE_REFUSE';
    this.role = nom;
    this.raisons = raisons;
  }
}

/**
 * Etat d'un role, lu en une seule requete.
 *
 * `objets_possedes` compte les dependances de type `o` (proprietaire) : les
 * GRANT, eux, sont de type `a` et ne rendent pas un role « proprietaire ». Un
 * role qui possede des objets a servi a quelque chose qu'on ignore : il n'est
 * pas un role applicatif frais.
 */
async function etatRole(db, nom) {
  const { rows } = await db.query(
    `SELECT r.oid, r.rolbypassrls, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
            (SELECT count(*)::int
               FROM pg_shdepend d
              WHERE d.refclassid = 'pg_authid'::regclass
                AND d.refobjid = r.oid
                AND d.deptype = 'o') AS objets_possedes
       FROM pg_roles r
      WHERE r.rolname = $1`,
    [nom],
  );
  return rows.length === 0 ? null : { ...rows[0], oid: String(rows[0].oid) };
}

/**
 * Cree (ou reaffirme) le role applicatif et ses droits par defaut.
 *
 * Idempotent : relancer ne duplique ni ne casse rien. Doit etre appelee
 * avant `prisma migrate deploy` sur une base vierge, et reste sans effet
 * dommageable sur une base ou le role existe deja.
 *
 * GARDE D'OID ET DE CONSERVATION (30/10)
 *
 * Avant : `select 1 from pg_roles` puis `CREATE` ou `ALTER ROLE ... PASSWORD`.
 * Un `tracefab_app` PREEXISTANT et etranger voyait son mot de passe reecrit et
 * ses attributs rabattus, sans qu'aucune preuve n'ait ete faite qu'il etait le
 * notre. Desormais :
 *
 *   1. l'etat est lu UNE fois, avant toute ecriture (OID, attributs, objets
 *      possedes) ;
 *   2. un role preexistant PRIVILEGIE (SUPERUSER, BYPASSRLS, CREATEROLE,
 *      CREATEDB) ou PROPRIETAIRE d'objets est REFUSE par `RolePreexistantRefuse`
 *      — aucune ecriture, mot de passe et attributs intacts ;
 *   3. un role preexistant ordinaire est reaffirme (comportement historique) ;
 *   4. l'OID est relu APRES : s'il a change, le provisioning ne portait pas sur
 *      le role inspecte et l'appel echoue.
 *
 * Le pendant de cette garde pour `prepare_ci_db_role.mjs` a ete pose dans le
 * meme chantier ; les deux scripts sont invoques sur la meme base par des
 * chemins differents et doivent se comporter pareil.
 *
 * @param {import('pg').Client} db connexion proprietaire de la base
 * @param {string} password mot de passe du role applicatif
 */
export async function ensureAppRole(db, password, { role = APP_ROLE } = {}) {
  // Surcharge de nom : elle n'existe que pour eprouver les refus sur un cluster
  // jetable, et reste bornee aux noms `tf_*` — un test ne peut donc pas viser
  // `postgres` ni un role d'exploitation. Meme regle que
  // `prepare_ci_db_role.mjs` (`TF_APP_ROLE_NAME`).
  if (role !== APP_ROLE && !/^tf_[a-z0-9_]+$/.test(role)) {
    throw new Error(`nom de role ${role} hors liste fermee (${APP_ROLE} ou tf_*)`);
  }
  const avant = await etatRole(db, role);

  const sqlCreate = `CREATE ROLE ${role} LOGIN PASSWORD ${quote(password)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`;
  const sqlAlter = `ALTER ROLE ${role} WITH LOGIN PASSWORD ${quote(password)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`;

  if (avant === null) {
    await provoquerRole(db, sqlCreate, sqlAlter, 'creation');
    console.log(`  role ${role} cree (sans BYPASSRLS)`);
  } else {
    // Refus AVANT toute ecriture : ni le mot de passe ni les attributs du role
    // preexistant ne sont touches.
    const raisons = [];
    if (avant.rolsuper) raisons.push('SUPERUSER');
    if (avant.rolbypassrls) raisons.push('BYPASSRLS');
    if (avant.rolcreaterole) raisons.push('CREATEROLE');
    if (avant.rolcreatedb) raisons.push('CREATEDB');
    if (avant.objets_possedes > 0) raisons.push(`proprietaire de ${avant.objets_possedes} objet(s)`);
    if (raisons.length > 0) {
      throw new RolePreexistantRefuse(role, raisons);
    }
    await provoquerRole(db, sqlCreate, sqlAlter, 'alter');
    console.log(`  role ${role} deja present (OID ${avant.oid}), attributs reaffirmes (sans BYPASSRLS)`);
  }

  // Preuve d'identite : le role relu doit etre celui qu'on a cree ou reaffirme.
  const apres = await etatRole(db, role);
  if (apres === null) {
    throw new Error(`le role ${role} a disparu pendant le provisioning.`);
  }
  if (avant !== null && apres.oid !== avant.oid) {
    throw new Error(`le role ${role} a change d'OID pendant le provisioning `
      + `(${avant.oid} -> ${apres.oid}) : le provisioning ne porte pas sur le role inspecte.`);
  }
  if (apres.rolbypassrls || apres.rolsuper || apres.rolcreaterole || apres.rolcreatedb) {
    throw new Error(`${role} possede un attribut privilegie inattendu apres provisioning.`);
  }
  if (!apres.rolcanlogin) {
    throw new Error(`${role} n'a pas LOGIN apres provisioning.`);
  }

  if (role !== APP_ROLE) {
    // Surcharge de test : les droits applicatifs visent `tracefab_app` par leur
    // nom dans plusieurs blocs `DO`/`GRANT`. Les accorder a un role de sonde
    // elargirait sa surface sans rien prouver — on s'arrete au provisioning,
    // qui est precisement ce que la surcharge sert a eprouver.
    console.log(`  role ${role} provisonne (surcharge de test : droits applicatifs non accordes)`);
    return;
  }

  const base = (await db.query('select current_database() d')).rows[0].d;
  const proprio = (await db.query('select current_user u')).rows[0].u;

  for (const sql of [
    `GRANT CONNECT ON DATABASE "${base}" TO ${APP_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
    // LECTURE sur toutes les tables : le client Prisma lit directement, et la
    // RLS — activee et forcee sur les 50 tables — filtre ce qui est visible.
    // La lecture large est donc contenue ; l'ecriture large ne l'etait pas.
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    // Re-bootstrap must not restore runtime access to Prisma's control-plane ledger.
    `DO $bootstrap$ BEGIN
       IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
         EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM ${APP_ROLE}';
       END IF;
     END $bootstrap$;`,
    // ECRITURE sur les seules tables que le runtime touche hors fonction.
    // Auparavant : GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES, ce qui
    // rendait toute table modifiable directement et vidait de son sens le
    // principe « mutations par fonctions ».
    //
    // CORRECTION DU 29/10 — la condition portait sur UNE table :
    //     IF to_regclass('public.rate_limit_counters') IS NOT NULL THEN
    //       EXECUTE 'GRANT ... ON <les 16 tables> ...'
    // `rate_limit_counters` servait donc de sentinelle pour seize tables, avec
    // deux consequences MESUREES sur base jetable :
    //   — sentinelle absente, autres tables presentes : aucune des 16 ne recoit
    //     son droit d'ecriture (mesure : organizations et audit_logs a false) ;
    //   — sentinelle presente, une seule des 16 absente : le GRANT global leve
    //     42P01 (`relation "data_points" does not exist`) et TOUT le
    //     provisionnement echoue. Le bootstrap devenait dependant de l'existence
    //     simultanee des seize.
    // L'octroi est desormais fait TABLE PAR TABLE, sur celles qui existent :
    // idempotent, independant de l'ordre role/migrations, et sans elargissement
    // (meme liste, memes privileges, seules les tables presentes).
    `DO $grant_dml$
     DECLARE
       v_table text;
     BEGIN
       FOREACH v_table IN ARRAY ARRAY[${TABLES_ECRITURE_DIRECTE.map((t) => `'${t}'`).join(', ')}]::text[]
       LOOP
         IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
           EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO %I', v_table, '${APP_ROLE}');
         END IF;
       END LOOP;
     END
     $grant_dml$;`,
    // `tracefab_products` : ecriture COLONNE PAR COLONNE, jamais au niveau
    // table. Les champs calcules restent hors de portee du runtime.
    `DO $$ BEGIN
       IF to_regclass('public.tracefab_products') IS NOT NULL THEN
         EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.tracefab_products FROM ${APP_ROLE}';
         EXECUTE 'GRANT INSERT (${COLONNES_ECRITURE_PRODUIT.join(', ')}), UPDATE (${COLONNES_ECRITURE_PRODUIT.join(', ')}) ON public.tracefab_products TO ${APP_ROLE}';
       END IF;
     END $$;`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`,
    // EXECUTE sur les fonctions : les nouveaux objets ne doivent pas en hériter.
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" REVOKE EXECUTE ON FUNCTIONS FROM ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ${APP_ROLE}`,
    // Nettoyer les défauts DML globaux ET ceux du schéma public : un REVOKE
    // par schéma ne neutralise pas un GRANT global (et inversement).
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" REVOKE INSERT, UPDATE, DELETE ON TABLES FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" REVOKE INSERT, UPDATE, DELETE ON TABLES FROM ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM ${APP_ROLE}`,
    // Les tables futures n'accordent au runtime que la lecture. Toute écriture
    // directe nouvelle exige un GRANT explicite sur la table cible.
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT SELECT ON TABLES TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`,

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
      `tracefab_products en ecriture colonne par colonne (${COLONNES_ECRITURE_PRODUIT.length} colonnes, champs calcules exclus) ; ` +
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
