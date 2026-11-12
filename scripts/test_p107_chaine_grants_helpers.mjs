#!/usr/bin/env node
/**
 * P10.7 — la CHAINE DE MIGRATIONS, rejouee depuis une base neuve, laisse-t-elle
 * les fonctions SECURITY DEFINER capables d'appeler les helpers qu'elles
 * emploient ?
 *
 * POURQUOI CE BANC EXISTE
 *
 * L'etape 45 du job `base-de-donnees` a echoue le 2026-11-12 sur
 * `expected SQL error invitation_email_mismatch`, cause reelle :
 *
 *     42501 permission denied for function tracefab_current_user_email
 *
 * `20261105235900_active_tenant_policy_and_worker_closure` transfere ce helper
 * a `tracefab_worker` et n'accorde EXECUTE qu'a `tracefab_app` — le role qui
 * APPELLE. Mais le corps d'une fonction SECURITY DEFINER s'execute avec les
 * privileges de son PROPRIETAIRE (`tracefab_migrator`), qui ne detenait pas ce
 * droit.
 *
 * La suite `test_p107_grants_helpers_definer.mjs` mesure l'etat de la base et
 * fait le controle negatif (revocation -> 42501). Elle ne peut pas, a elle
 * seule, prouver que la CHAINE produit cet etat : elle tourne sur une base
 * deja migree. Ce banc-ci rejoue la chaine COMPLETE DEUX FOIS depuis une base
 * neuve — sans la migration 20261112120000, puis avec — et compare :
 *
 *     chaine sans le correctif : tracefab_migrator ne peut PAS executer le helper
 *     chaine avec le correctif : il le peut
 *
 * C'est la seule forme de preuve qui distingue « la base est bien configuree »
 * de « la migration configure bien la base ». Un correctif livre sans cette
 * comparaison ne prouve rien sur une base neuve — or c'est exactement ce que
 * fait la CI a chaque execution.
 *
 * Sorties : 0 vert · 1 echec · 2 non execute.
 */
import pg from 'pg';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appliquerCommeLeRunner } from './lib/appliquer_chaine_comme_le_runner.mjs';

const URL_BASE = process.env.DATABASE_URL;
if (!URL_BASE) {
  console.error('NON EXECUTE — DATABASE_URL absente.');
  process.exit(2);
}
const hote = new URL(URL_BASE).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(hote)) {
  console.error(`NON EXECUTE — hote « ${hote} » refuse : ce banc cree des bases.`);
  process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = join(ROOT, 'prisma/migrations');
const CORRECTIF = '20261112120000_grants_helpers_entre_fonctions_definer';
const HELPER = 'public.tracefab_current_user_email()';
const PROPRIETAIRE = 'tracefab_migrator';

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const verif = (c, m, obs) => (c ? ok(m) : (echecs += 1, console.log(`  ECHEC ${m} — observe : ${obs}`)));

/** URL de la base maitresse (celle de DATABASE_URL, base remplacee). */
const urlAdmin = (() => {
  const u = new URL(URL_BASE);
  u.pathname = '/postgres';
  return u.toString();
})();
const urlBase = (nom) => {
  const u = new URL(URL_BASE);
  u.pathname = `/${nom}`;
  return u.toString();
};

const admin = new pg.Client({ connectionString: urlAdmin });
await admin.connect();

const dossiers = readdirSync(MIG_DIR)
  .filter((n) => statSync(join(MIG_DIR, n)).isDirectory()
    && statSync(join(MIG_DIR, n, 'migration.sql')).isFile())
  .sort();

/**
 * Rejoue la chaine sur une base neuve.
 * @param {string} nom identifiant de la base jetable
 * @param {boolean} avecCorrectif faut-il appliquer la migration du correctif
 * @returns {Promise<{privilege: boolean|null, migrations: number, interruption: string|null}>}
 */
async function rejouer(nom, avecCorrectif) {
  await admin.query(`DROP DATABASE IF EXISTS "${nom}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${nom}"`);
  const c = new pg.Client({ connectionString: urlBase(nom) });
  await c.connect();
  let migrations = 0;
  let interruption = null;
  try {
    // Le role doit exister AVANT la chaine : c'est l'ordre de la CI (etape 5),
    // et c'est ce qui rend le transfert de propriete possible.
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROPRIETAIRE}') THEN
        CREATE ROLE ${PROPRIETAIRE} LOGIN;
      END IF;
    END $$;`);
    for (const dossier of dossiers) {
      if (!avecCorrectif && dossier === CORRECTIF) continue;
      try {
        await appliquerCommeLeRunner(c, dossier, readFileSync(join(MIG_DIR, dossier, 'migration.sql'), 'utf8'));
        migrations += 1;
      } catch (e) {
        interruption = `${dossier}: ${e.code} ${String(e.message).split('\n')[0]}`;
        break;
      }
    }
    let privilege = null;
    if (!interruption) {
      const r = await c.query(
        'SELECT has_function_privilege($1, to_regprocedure($2), \'EXECUTE\') AS n',
        [PROPRIETAIRE, HELPER]);
      privilege = r.rows[0].n;
    }
    return { privilege, migrations, interruption };
  } finally {
    await c.end();
  }
}

try {
  console.log(`\n  chaine de ${dossiers.length} migrations, rejouee depuis une base neuve`);

  /* --- A. sans le correctif : le defaut doit etre present ------------------ */
  console.log('\n  A. sans 20261112120000 — le defaut doit etre REPRODUIT');
  const sans = await rejouer('tf_preuve_sans_correctif', false);
  verif(sans.interruption === null, 'la chaine se rejoue jusqu au bout (sans le correctif)', sans.interruption ?? '');
  verif(sans.privilege === false,
    `${PROPRIETAIRE} ne peut PAS executer le helper (defaut reproduit)`,
    String(sans.privilege));

  /* --- B. avec le correctif : le defaut doit disparaitre ------------------- */
  console.log('\n  B. avec 20261112120000 — le defaut doit DISPARAITRE');
  const avec = await rejouer('tf_preuve_avec_correctif', true);
  verif(avec.interruption === null, 'la chaine se rejoue jusqu au bout (avec le correctif)', avec.interruption ?? '');
  verif(avec.privilege === true,
    `${PROPRIETAIRE} peut executer le helper apres la chaine`,
    String(avec.privilege));

  /* --- C. le correctif ne rouvre pas PUBLIC ------------------------------- */
  console.log('\n  C. le correctif n ouvre pas PUBLIC');
  const c = new pg.Client({ connectionString: urlBase('tf_preuve_avec_correctif') });
  await c.connect();
  const pub = await c.query(`
    SELECT count(*)::int n
      FROM pg_proc p,
           pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
     WHERE p.proname = 'tracefab_current_user_email'
       AND p.pronamespace = 'public'::regnamespace
       AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`);
  await c.end();
  verif(Number(pub.rows[0].n) === 0, 'PUBLIC reste sans EXECUTE', `entrees=${pub.rows[0].n}`);

  console.log(echecs
    ? `\n${echecs} echec(s) — la chaine ne produit pas l etat attendu.`
    : '\nChaine verifiee : le defaut est reproduit sans le correctif, absent avec, et PUBLIC reste ferme.');
} finally {
  for (const nom of ['tf_preuve_sans_correctif', 'tf_preuve_avec_correctif']) {
    await admin.query(`DROP DATABASE IF EXISTS "${nom}" WITH (FORCE)`).catch(() => {});
  }
  await admin.end();
}

process.exit(echecs ? 1 : 0);
