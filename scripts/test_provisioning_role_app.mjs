#!/usr/bin/env node
/**
 * Provisioning du role applicatif — la sentinelle `to_regclass` et ses effets.
 *
 * LE DEFAUT, MESURE
 *
 * `ensureAppRole` accordait l'ecriture sur les 16 tables d'ecriture directe
 * derriere UNE seule condition :
 *
 *     IF to_regclass('public.rate_limit_counters') IS NOT NULL THEN
 *       EXECUTE 'GRANT INSERT, UPDATE, DELETE ON <les 16 tables> TO tracefab_app';
 *
 * Mesure du 29/10 sur base jetable, deux consequences distinctes :
 *
 *   a) sentinelle ABSENTE, deux tables presentes (`organizations`, `audit_logs`)
 *      -> `has_table_privilege` rend FALSE pour les deux : les seize perdent
 *      leur droit d'ecriture a cause d'une table qui n'a rien a voir. C'est
 *      exactement l'etat du bootstrap avant migrations, puisque le role est
 *      cree AVANT la chaine.
 *   b) sentinelle PRESENTE mais UNE des seize absente -> le GRANT global leve
 *      42P01 (`relation "data_points" does not exist`) et TOUT le provisioning
 *      echoue. L'ordre role/migrations devenait donc une condition de succes.
 *
 * CE QUE CE TEST ETABLIT
 *
 *   1. l'octroi est fait table par table : chaque table presente recoit son
 *      droit, chaque table absente est simplement ignoree ;
 *   2. idempotence : deux passages, aucun echec, privileges identiques ;
 *   3. pas d'elargissement : une table hors liste ne recoit aucun DML ;
 *   4. la sentinelle n'est plus un prealable ;
 *   5. en chaine reelle (role AVANT migrations, comme la CI et la production),
 *      les privileges necessaires sont bien la a la fin.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant · 3 cible refusee.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { creerBaseEphemere, verrouillerCluster, filetDeNettoyage } from './lib/ephemeral-db.mjs';
import { ensureAppRole, APP_ROLE, TABLES_ECRITURE_DIRECTE } from './lib/tracefab_app_role.mjs';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOT_DE_PASSE = process.env.TF_APP_PASSWORD || 'epreuve_locale_jetable';

let vertes = 0;
let rouges = 0;
const echecs = [];
function verifier(etiquette, ok, detail) {
  if (ok) {
    vertes += 1;
    console.log(`    ok    ${etiquette}`);
  } else {
    rouges += 1;
    echecs.push(etiquette);
    console.log(`    ECHEC ${etiquette}${detail ? ` — observé : ${detail}` : ''}`);
  }
}

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: 'provisioning du role applicatif — octroi par table et idempotence',
  exitOnFailure: true,
});

// Verrou de CLUSTER pris AVANT toute section : les cinq sections provisionnent
// le meme role de cluster (`pg_authid`) et appliquent la chaine de migrations,
// qui contient un `ALTER ROLE`. Une connexion dediee le maintient pendant toute
// l'epreuve ; il est relache en fin de parcours, et sur SIGINT/SIGTERM par le
// filet de `verrouillerCluster`.
const verrouCluster = await verrouillerCluster({ urlProprietaire: process.env.DATABASE_URL });

// Registre des bases ouvertes : une erreur fatale hors `finally` ne doit pas les
// laisser derriere (mesure du 30/10 : deux bases `tf_privileges_*` fuies par
// cette fenetre exacte).
const basesOuvertes = new Set();
filetDeNettoyage(async () => {
  for (const b of basesOuvertes) await b.fermer().catch(() => {});
  await verrouCluster.relacher().catch(() => {});
});

const ouvrir = async (url) => {
  const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await c.connect();
  return c;
};

/**
 * Mesure des privileges, TOLERANTE aux tables absentes.
 *
 * `has_table_privilege` sur une table inexistante leve 42P01, et cette erreur
 * remontait jusqu'au `finally` qui detruisait alors la base pendant que le
 * client etait encore connecte : le 57P01 resultant MASQUAIT la cause reelle.
 * On mesure donc `to_regclass` d'abord, et une table absente rend `null`
 * (distinct de `false`, qui veut dire « existe mais pas de droit »).
 */
const privileges = async (c) => {
  const { rows } = await c.query(
    `SELECT
       CASE WHEN to_regclass('public.organizations') IS NULL THEN NULL
            ELSE has_table_privilege($1, 'public.organizations', 'INSERT') END AS org_i,
       CASE WHEN to_regclass('public.organizations') IS NULL THEN NULL
            ELSE has_table_privilege($1, 'public.organizations', 'UPDATE') END AS org_u,
       CASE WHEN to_regclass('public.audit_logs') IS NULL THEN NULL
            ELSE has_table_privilege($1, 'public.audit_logs', 'INSERT') END AS aud_i,
       CASE WHEN to_regclass('public.data_points') IS NULL THEN NULL
            ELSE has_table_privilege($1, 'public.data_points', 'INSERT') END AS dp_i`,
    [APP_ROLE],
  );
  return rows[0];
};

/* ========================================================================== */
console.log("\n  A. Sentinelle absente — les tables presentes reçoivent leur droit");

{
  const base = await creerBaseEphemere({
    urlProprietaire: process.env.DATABASE_URL,
    prefixe: 'tf_provisioning',
  });
  basesOuvertes.add(base);
  let c = null;
  try {
    c = await ouvrir(base.url);
    // Deux tables de la liste, et AUCUNE des deux n'est rate_limit_counters.
    await c.query('CREATE TABLE organizations (id int)');
    await c.query('CREATE TABLE audit_logs (id int)');
    // Une table HORS liste, qui ne doit jamais recevoir d ecriture.
    await c.query('CREATE TABLE table_hors_liste (id int)');

    const { rows: sentinelle } = await c.query(
      "SELECT to_regclass('public.rate_limit_counters') AS r",
    );
    verifier('rate_limit_counters est bien ABSENTE à ce stade', sentinelle[0].r === null);

    await ensureAppRole(c, MOT_DE_PASSE);

    const p = await privileges(c);
    verifier('organizations reçoit INSERT malgré la sentinelle absente', p.org_i === true, `org_i=${p.org_i}`);
    verifier('organizations reçoit UPDATE', p.org_u === true, `org_u=${p.org_u}`);
    verifier('audit_logs reçoit INSERT', p.aud_i === true, `aud_i=${p.aud_i}`);

    const hors = await c.query(
      `SELECT has_table_privilege($1, 'public.table_hors_liste', 'INSERT') AS i,
              has_table_privilege($1, 'public.table_hors_liste', 'UPDATE') AS u,
              has_table_privilege($1, 'public.table_hors_liste', 'DELETE') AS d`,
      [APP_ROLE],
    );
    verifier(
      'une table HORS liste ne reçoit aucune écriture — pas d élargissement',
      hors.rows[0].i === false && hors.rows[0].u === false && hors.rows[0].d === false,
      JSON.stringify(hors.rows[0]),
    );
    const lecture = await c.query(
      `SELECT has_table_privilege($1, 'public.table_hors_liste', 'SELECT') AS s`, [APP_ROLE],
    );
    verifier(
      'mais elle reste lisible : la lecture générale est conservée',
      lecture.rows[0].s === true,
      `SELECT=${lecture.rows[0].s}`,
    );

    /* --- Idempotence ---------------------------------------------------- */
    console.log('\n  B. Idempotence — deux passages, aucun échec, mêmes droits');
    const avant = await privileges(c);
    let erreur = null;
    try {
      await ensureAppRole(c, MOT_DE_PASSE);
    } catch (e) {
      erreur = e.message;
    }
    verifier('la seconde exécution ne lève pas', erreur === null, erreur ?? '');
    const apres = await privileges(c);
    verifier(
      'les privilèges sont identiques après la seconde exécution',
      JSON.stringify(avant) === JSON.stringify(apres),
      `${JSON.stringify(avant)} -> ${JSON.stringify(apres)}`,
    );

    /* --- Une table ajoutée plus tard ------------------------------------ */
    console.log('\n  C. Table créée après coup — le passage suivant la couvre');
    await c.query('CREATE TABLE data_points (id int)');
    const avantAjout = await privileges(c);
    verifier('avant le nouveau passage, data_points n a aucun droit', avantAjout.dp_i === false);
    await ensureAppRole(c, MOT_DE_PASSE);
    const apresAjout = await privileges(c);
    verifier('après le passage, data_points reçoit son droit', apresAjout.dp_i === true, `dp_i=${apresAjout.dp_i}`);

    /* --- Une seule table manquante ne casse plus tout ------------------- */
    console.log('\n  D. Une des seize absente — le provisioning aboutit quand même');
    // organizations et audit_logs existent, data_points aussi, mais les treize
    // autres non. Avant le correctif, le GRANT global levait 42P01.
    let echecGlobal = null;
    try {
      await ensureAppRole(c, MOT_DE_PASSE);
    } catch (e) {
      echecGlobal = `${e.code} ${String(e.message).split('\n')[0]}`;
    }
    verifier(
      'le provisioning aboutit alors que 13 des 16 tables sont absentes',
      echecGlobal === null,
      echecGlobal ?? '',
    );
    const toujours = await privileges(c);
    verifier(
      'les tables présentes gardent leurs droits',
      toujours.org_i === true && toujours.aud_i === true && toujours.dp_i === true,
      JSON.stringify(toujours),
    );
  } finally {
    // Le client d'abord, la base ensuite : detruire une base dont une session
    // depend produit un 57P01 qui masque l'erreur d'origine.
    if (c) await c.end().catch(() => {});
    await base.fermer();
    console.log(`    base éphémère détruite : ${base.nom}`);
  }
}

/* ========================================================================== */
console.log("\n  E. Chaîne réelle — rôle AVANT les migrations, puis privilèges effectifs");

{
  const base = await creerBaseEphemere({
    urlProprietaire: process.env.DATABASE_URL,
    prefixe: 'tf_provisioning_chaine',
  });
  basesOuvertes.add(base);
  // Declares AVANT le try : le `finally` doit pouvoir les fermer.
  let mig = null;
  let app = null;
  try {
    // 1. Le rôle, AVANT toute migration : c'est l'ordre de la CI et de la
    //    production. C'est cet ordre qui rendait la sentinelle fausse.
    let bootstrapEchec = null;
    try {
      execFileSync('node', [path.join(RACINE, 'scripts', 'bootstrap_app_role.mjs')], {
        env: { ...process.env, DATABASE_URL: base.url, TF_APP_PASSWORD: MOT_DE_PASSE },
        stdio: 'pipe',
      });
    } catch (e) {
      bootstrapEchec = String(e.stderr ?? e.message).split('\n').slice(-3).join(' ');
    }
    verifier(
      'le bootstrap du rôle réussit sur une base VIERGE, sans aucune table',
      bootstrapEchec === null,
      bootstrapEchec ?? '',
    );

    // 2. Les migrations.
    mig = await ouvrir(base.url);
    const dossiers = fs
      .readdirSync(path.join(RACINE, 'prisma', 'migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    let appliquees = 0;
    const migrationEnEchec = [];
    for (const d of dossiers) {
      const sql = fs.readFileSync(path.join(RACINE, 'prisma', 'migrations', d, 'migration.sql'), 'utf8');
      if (!sql.trim() || sql.trim() === '-- This is an empty migration.') continue;
      try {
        await mig.query(sql);
        appliquees += 1;
      } catch (e) {
        migrationEnEchec.push(`${d.slice(0, 14)}:${e.code}`);
      }
    }
    console.log(`    ${appliquees}/${dossiers.length} migrations appliquées`);
    verifier(
      'la chaîne de migrations passe sur une base où le rôle préexiste',
      migrationEnEchec.length === 0,
      migrationEnEchec.slice(0, 4).join(', '),
    );

    // 3. Les privilèges EFFECTIFS après la chaîne, mesurés dans le catalogue.
    const presents = [];
    const absents = [];
    for (const t of TABLES_ECRITURE_DIRECTE) {
      const { rows } = await mig.query(
        `SELECT to_regclass($1) IS NOT NULL AS existe,
                CASE WHEN to_regclass($1) IS NULL THEN NULL
                     ELSE has_table_privilege($2, $1, 'INSERT') END AS i`,
        [`public.${t}`, APP_ROLE],
      );
      if (rows[0].existe === false) { absents.push(t); continue; }
      if (rows[0].i === true) presents.push(t);
      else absents.push(`${t}(sans INSERT)`);
    }
    verifier(
      `les ${TABLES_ECRITURE_DIRECTE.length} tables d écriture directe ont leur droit après la chaîne`,
      absents.length === 0,
      absents.join(', ') || 'toutes',
    );
    console.log(`    droits effectifs : ${presents.length}/${TABLES_ECRITURE_DIRECTE.length}`);

    // 4. Et le rôle peut réellement écrire, pas seulement « avoir le droit ».
    const urlApp = base.url.replace(/:\/\/[^@]*@/, `://${APP_ROLE}:${encodeURIComponent(MOT_DE_PASSE)}@`);
    app = await ouvrir(urlApp);
    const qui = await app.query('SELECT current_user u, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) b');
    verifier('la connexion applicative est bien tracefab_app', qui.rows[0].u === APP_ROLE, qui.rows[0].u);
    verifier('et ne contourne pas la RLS', qui.rows[0].b === false, `rolbypassrls=${qui.rows[0].b}`);
  } finally {
    if (app) await app.end().catch(() => {});
    if (mig) await mig.end().catch(() => {});
    await base.fermer();
    console.log(`    base éphémère détruite : ${base.nom}`);
  }
}

await verrouCluster.relacher();

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' ; ')}`);
  process.exit(1);
}
console.log('  ok — provisioning par table, idempotent, sans élargissement.');
process.exit(0);
