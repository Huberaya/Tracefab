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

  // Tables que le runtime ecrit DIRECTEMENT, hors fonctions SECURITY DEFINER.
  // Liste etablie par extraction des ordres INSERT / UPDATE / DELETE de api/,
  // croisee avec les tables reellement creees par les migrations — et non
  // reprise d'une intention. Toute autre mutation applicative passe par une
  // fonction, dont le proprietaire porte les privileges.
  //
  //   documents                     api/_lib/documents.ts:107            (UPDATE)
  //   rate_limit_counters           api/_lib/rate-limit.ts:403,415       (INSERT, DELETE)
  //   tracefab_catalog_import_jobs  api/_routes/catalog/*/import.ts      (INSERT)
  //   audit_logs                    api/_routes/catalog/*/import.ts      (INSERT)
  //
  // Ajouter une table ici doit etre justifie par un chemin applicatif precis.
  // Le controle scripts/test_privileges_role_app.mjs echoue si un octroi global
  // reapparait a la place de cette liste.
  const TABLES_ECRITURE_DIRECTE = [
    'audit_logs',
    'documents',
    'rate_limit_counters',
    'tracefab_catalog_import_jobs',
  ];
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
