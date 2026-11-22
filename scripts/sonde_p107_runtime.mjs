#!/usr/bin/env node
/**
 * P10.7 — SONDE CÔTÉ RUNTIME : QUELLE IDENTITÉ, QUELLE ESCALADE, QUEL POOLER ?
 *
 * POURQUOI ELLE EXISTE, ET EN QUOI ELLE DIFFÈRE DE LA SONDE DE CATALOGUE
 *
 * `docs/security/2026-11-02-p107-sonde-identite-et-etat-cible.sql` lit le
 * catalogue avec le rôle de l'OPÉRATEUR. Elle ne peut pas dire quel rôle
 * l'application utilise : ce rôle n'existe que sur la connexion de
 * l'application. Deux chemins le mesurent, et ce script est le second :
 *
 *   1. `GET /api/internal/p2-readiness?identity=1` — passe par le MÊME client
 *      Prisma que les routes (c'est le chemin de référence) ;
 *   2. ce script — pour un opérateur qui a l'`URL` du runtime mais pas le
 *      secret worker : il ouvre une connexion avec cette URL et lit
 *      `current_user` sur SA connexion. Il ne remplace pas (1) : si l'URL
 *      testée n'est pas celle du déploiement, il mesure autre chose — c'est
 *      précisément pourquoi il imprime le nom du rôle au lieu de le supposer.
 *
 * CE QU'IL MESURE, ET QUI MANQUAIT
 *
 *   R1 l'identité : `current_user`, `session_user`, base, version ;
 *   R2 les attributs : SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB ;
 *   R3 les appartenances TRANSITIVES, et la capacité EFFECTIVE de prendre un
 *      rôle privilégié (`pg_has_role(..., 'SET')`) — les attributs seuls ne
 *      concluent pas ;
 *   R4 le POOLER : trois transactions successives, et l'on compare les
 *      `pg_backend_pid()`. Un pid qui change = regroupement par transaction
 *      (transaction pooling) ; un pid stable = session ou connexion directe.
 *      Ce n'est pas une curiosité : en transaction pooling, un `SET` de session
 *      n'est pas garanti, donc tout contexte posé par `SET` fuirait ou se
 *      perdrait. Le code applicatif pose son contexte avec
 *      `set_config(..., true)` (portée transaction) — R5 le vérifie ;
 *   R5 la portée du contexte : un GUC posé en `is_local = true` doit avoir
 *      DISPARU après la transaction. C'est la seule propriété qui rend le
 *      dispositif sûr quel que soit le mode du pooler ;
 *   R6 l'état de la clé d'identité côté application : `absente`, `valide` ou
 *      `invalide` — un état, jamais une valeur.
 *
 * CE QU'IL NE FAIT PAS : aucune écriture (`BEGIN READ ONLY` + `ROLLBACK` +
 * tentative d'écriture refusée), aucun secret affiché, aucune conclusion sur la
 * production si l'URL testée n'est pas celle du runtime.
 *
 * UTILISATION
 *   node scripts/sonde_p107_runtime.mjs --url "$URL_DU_RUNTIME" [--json]
 *   TF_P107_AUTORISER_HOTE_DISTANT=oui   (obligatoire hors localhost)
 *
 * Sortie : 0 mesure faite · 1 arrêt détecté · 2 non exécuté · 3 refus.
 */
import process from 'node:process';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const argument = (nom, defaut = null) => {
  const i = process.argv.indexOf(nom);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : defaut;
};
const url = (argument('--url') || process.env.TRACEFAB_RUNTIME_URL || '').trim();
const attendu = argument('--role-attendu', 'tracefab_app');
const sortieJson = process.argv.includes('--json');

if (!url) {
  console.error('  NON EXECUTE — fournir --url <URL DU RUNTIME> (ou TRACEFAB_RUNTIME_URL).');
  process.exit(2);
}
let hote = '';
try { hote = new URL(url).hostname; } catch { hote = ''; }
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote) && process.env.TF_P107_AUTORISER_HOTE_DISTANT !== 'oui') {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}). Relancer avec TF_P107_AUTORISER_HOTE_DISTANT=oui.`);
  process.exit(3);
}

/** État de la clé d'identité, SANS jamais lire la valeur. */
function etatCle(brute) {
  if (brute === undefined || brute.trim() === '') return 'absente';
  const v = brute.trim();
  return (v.length >= 64 && v.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(v)) ? 'valide' : 'invalide';
}

const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-p107-runtime' });
try {
  await client.connect();
} catch (e) {
  console.error(`  NON EXECUTE — connexion refusée (${e.code || 'inconnu'}).`);
  process.exit(2);
}

let rapport = null;
let probleme = null;
let ecriture = null;
try {
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ ONLY');
  const identite = (await client.query(
    `SELECT current_user AS role_courant,
            session_user AS role_session,
            current_database() AS base,
            pg_catalog.version() AS version,
            current_setting('server_version_num')::int AS version_num,
            inet_server_port() AS port_serveur,
            pg_catalog.pg_backend_pid() AS pid,
            (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user)      AS superuser,
            (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user)  AS bypassrls,
            (SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user) AS createrole,
            (SELECT rolcreatedb FROM pg_catalog.pg_roles WHERE rolname = current_user)   AS createdb`,
  )).rows[0];

  const appartenances = (await client.query(
    `WITH RECURSIVE atteignables(oid, profondeur) AS (
       SELECT r.oid, 0 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
       UNION
       SELECT m.roleid, a.profondeur + 1
         FROM atteignables a JOIN pg_catalog.pg_auth_members m ON m.member = a.oid
        WHERE a.profondeur < 8)
     SELECT r.rolname AS role_atteint,
            min(a.profondeur) AS profondeur,
            bool_or(r.rolsuper OR r.rolbypassrls) AS privilegie,
            pg_catalog.pg_has_role(current_user, r.oid, 'SET')   AS peut_prendre,
            pg_catalog.pg_has_role(current_user, r.oid, 'USAGE') AS herite
       FROM atteignables a JOIN pg_catalog.pg_roles r ON r.oid = a.oid
      WHERE a.profondeur > 0
      GROUP BY r.rolname, r.oid
      ORDER BY 2, 1`,
  )).rows;

  // Le contexte posé par l'application doit être TRANSACTIONNEL.
  await client.query(`SELECT set_config('tracefab.p107_portee', 'pose', true)`);
  const pendant = (await client.query(`SELECT current_setting('tracefab.p107_portee', true) AS v`)).rows[0].v;

  try {
    await client.query('CREATE TABLE tracefab_readonly_probe (x int)');
    ecriture = 'ACCEPTEE';
    console.log('         UNE ECRITURE A REUSSI dans la transaction de la sonde');
  } catch (e) {
    ecriture = /read-only transaction/i.test(e.message) ? '25006' : `refus inattendu ${e.code}`;
  }

  await client.query('ROLLBACK');

  const apres = (await client.query(`SELECT current_setting('tracefab.p107_portee', true) AS v`)).rows[0].v;

  // Trois transactions courtes : le pid change-t-il ?
  const pids = new Set();
  for (let i = 0; i < 3; i += 1) {
    await client.query('BEGIN');
    await client.query('SELECT 1');
    pids.add((await client.query('SELECT pg_catalog.pg_backend_pid() AS p')).rows[0].p);
    await client.query('ROLLBACK');
  }

  const privilegies = appartenances.filter((a) => a.privilegie === true);
  rapport = {
    schema: 'tracefab-p107-runtime-v1',
    role_attendu: attendu,
    role_courant: identite.role_courant,
    role_session: identite.role_session,
    base: identite.base,
    version_postgresql: identite.version,
    version_num: identite.version_num,
    port_serveur: identite.port_serveur,
    attributs: {
      superuser: identite.superuser,
      bypassrls: identite.bypassrls,
      createrole: identite.createrole,
      createdb: identite.createdb,
    },
    appartenances_transitives: appartenances.map((a) => ({
      role: a.role_atteint, profondeur: a.profondeur, privilegie: a.privilegie, peut_prendre: a.peut_prendre, herite: a.herite,
    })),
    roles_privilegies_atteignables: privilegies.map((a) => a.role_atteint),
    peut_prendre_un_role_privilegie: privilegies.some((a) => a.peut_prendre === true),
    pooler: {
      mode: pids.size > 1 ? 'transaction_pooling' : 'session_ou_direct',
      backends_observes: pids.size,
      transactions: 3,
    },
    contexte_transactionnel: {
      visible_dans_la_transaction: pendant === 'pose',
      absent_apres: apres === null || apres === '',
    },
    lecture_seule: ecriture,
    cle_identite: etatCle(process.env.TRACEFAB_IDENTITY_KEY),
  };
} catch (e) {
  probleme = `${e.code} ${e.message.split('\n')[0].slice(0, 90)}`;
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}

if (probleme) {
  console.error(`  NON EXECUTE — la sonde a échoué : ${probleme}`);
  process.exit(2);
}
if (rapport.lecture_seule !== '25006') {
  console.error(`  ARRET — la sonde a pu ÉCRIRE (${rapport.lecture_seule}).`);
  process.exit(1);
}

const arrets = [];
if (rapport.attributs.superuser === true) arrets.push('le rôle du runtime est SUPERUSER');
if (rapport.attributs.bypassrls === true) arrets.push('le rôle du runtime porte BYPASSRLS — la RLS n est pas opposable');
if (rapport.attributs.createrole === true) arrets.push('le rôle du runtime porte CREATEROLE');
if (rapport.attributs.createdb === true) arrets.push('le rôle du runtime porte CREATEDB');
if (rapport.role_courant !== rapport.role_attendu) arrets.push(`le rôle courant (${rapport.role_courant}) n est pas ${rapport.role_attendu}`);
if (rapport.role_session !== rapport.role_attendu) arrets.push(`le rôle de session (${rapport.role_session}) n est pas ${rapport.role_attendu}`);
if (rapport.peut_prendre_un_role_privilegie) arrets.push(`le runtime peut prendre ${rapport.roles_privilegies_atteignables.join(', ')}`);
if (!rapport.contexte_transactionnel.absent_apres) arrets.push('le contexte survit à la transaction — incompatible avec un pooler en mode transaction');
if (rapport.cle_identite === 'invalide') arrets.push('TRACEFAB_IDENTITY_KEY est PRÉSENTE mais malformée');
rapport.arrets = arrets;
rapport.verdict = arrets.length === 0 ? 'IDENTITE_CONFORME' : 'ARRET';
rapport.cle_identite === 'absente' && rapport.verdict === 'IDENTITE_CONFORME'
  ? rapport.observation = 'clé absente : le runtime ne peut pas signer, la base reste en mode permissif — transition, pas sécurité'
  : null;

if (sortieJson) {
  console.log(JSON.stringify(rapport, null, 2));
} else {
  console.log('');
  console.log('  Sonde P10.7 — côté RUNTIME');
  console.log(`  identité      : ${rapport.role_courant} (session ${rapport.role_session}) · base ${rapport.base}`);
  console.log(`  attributs     : superuser=${rapport.attributs.superuser} bypassrls=${rapport.attributs.bypassrls} createrole=${rapport.attributs.createrole} createdb=${rapport.attributs.createdb}`);
  console.log(`  appartenances : ${rapport.appartenances_transitives.length} rôle(s) atteint(s), ${rapport.roles_privilegies_atteignables.length} privilégié(s)`);
  console.log(`  pooler        : ${rapport.pooler.mode} (${rapport.pooler.backends_observes} backend(s) pour ${rapport.pooler.transactions} transactions)`);
  console.log(`  contexte      : visible dans la transaction=${rapport.contexte_transactionnel.visible_dans_la_transaction} · absent après=${rapport.contexte_transactionnel.absent_apres}`);
  console.log(`  lecture seule : ${rapport.lecture_seule}`);
  console.log(`  clé identité  : ${rapport.cle_identite}`);
  console.log('');
  if (arrets.length === 0) console.log('  IDENTITÉ CONFORME au contrat P10.7.');
  else {
    console.log(`  ${arrets.length} ARRÊT(S) :`);
    for (const a of arrets) console.log(`    - ${a}`);
  }
  console.log('');
}

process.exit(arrets.length === 0 ? 0 : 1);
