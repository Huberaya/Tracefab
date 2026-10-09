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
  for (const sql of [
    `GRANT CONNECT ON DATABASE "${base}" TO ${APP_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
    // Droits sur l'existant, puis droits par defaut pour tout objet futur :
    // sans la deuxieme moitie, chaque migration creant une table laisserait
    // le role applicatif sans droit dessus — silencieusement.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${APP_ROLE}`,
  ]) {
    await db.query(sql);
  }
  console.log(`  droits applicatifs accordes a ${APP_ROLE}`);
}

/**
 * Convenience : connexion au proprio puis ensureAppRole.
 * @param {string} urlProprio DATABASE_URL (proprietaire)
 * @param {string} password mot de passe du role applicatif
 */
export async function ensureAppRoleFromUrl(urlProprio, password) {
  const avecSsl = /sslmode=(require|verify-full|verify-ca)/.test(urlProprio);
  const db = new pg.Client({
    connectionString: urlProprio,
    ssl: avecSsl ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  try {
    await ensureAppRole(db, password);
  } finally {
    await db.end();
  }
}
