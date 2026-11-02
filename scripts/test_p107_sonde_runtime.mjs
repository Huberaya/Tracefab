#!/usr/bin/env node
/**
 * P10.7 — LA SONDE CÔTÉ RUNTIME MESURE-T-ELLE LA BONNE CHOSE, ET REFUSE-T-ELLE
 * LES MAUVAISES IDENTITÉS ?
 *
 * Le défaut que ce test empêche : une sonde d'identité qui rend
 * « conforme » quoi qu'il arrive. Elle serait pire qu'aucune sonde, parce
 * qu'elle produirait la preuve qu'on cherche. On exige donc un TÉMOIN NÉGATIF
 * (un rôle privilégié doit être refusé) et un TÉMOIN POSITIF (un rôle conforme
 * doit être accepté) — sans les deux, le contrôle est vacant.
 *
 *   T1 rôle applicatif conforme            -> code 0, verdict IDENTITE_CONFORME
 *   T2 `postgres` (SUPERUSER + BYPASSRLS)  -> code 1, chaque attribut nommé
 *   T3 rôle sans attribut mais MEMBRE d'un rôle privilégié -> code 1 (escalade)
 *   T4 clé d'identité : état seulement, jamais la valeur
 *   T5 lecture seule prouvée (25006), contexte transactionnel absent après
 *   T6 refus d'une cible distante sans opt-in (3), refus sans URL (2)
 *
 * Env : DATABASE_URL (superutilisateur de la base jetable), TF_RLS_APP_URL
 * (rôle applicatif). Sortie : 0 conforme · 1 régression · 2 non exécuté.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { verrouillerCluster } from './lib/ephemeral-db.mjs';

const urlAdmin = (process.env.DATABASE_URL || '').trim();
const urlApp = (process.env.TF_RLS_APP_URL || '').trim();
if (!urlAdmin || !urlApp) {
  console.error('  NON EXECUTE — DATABASE_URL et TF_RLS_APP_URL sont requises.');
  process.exit(2);
}

const LANCEUR = 'scripts/sonde_p107_runtime.mjs';
let assertions = 0;
let echecs = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

const lancer = (args, envSup = {}) => spawnSync(process.execPath, [LANCEUR, ...args], {
  encoding: 'utf8', env: { ...process.env, ...envSup },
});
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

/* --- T1 : rôle conforme --------------------------------------------------- */
const conforme = lancer(['--url', urlApp, '--json']);
const r1 = json(conforme);
ok(conforme.status === 0 && r1?.verdict === 'IDENTITE_CONFORME',
  'T1 le rôle applicatif réel est CONFORME (contrôle positif, sans quoi le reste serait vacant)',
  `code ${conforme.status} · ${r1?.verdict || conforme.stderr.slice(0, 60)}`);
ok(r1?.appartenances_transitives?.length === 0,
  'T1 le rôle applicatif n atteint aucun autre rôle',
  (r1?.appartenances_transitives || []).map((a) => a.role).join(', ') || 'aucun');
ok(r1?.attributs?.superuser === false && r1?.attributs?.bypassrls === false,
  'T1 mesuré, pas supposé : NOSUPERUSER et NOBYPASSRLS', JSON.stringify(r1?.attributs));

/* --- T5 : lecture seule et portée du contexte ---------------------------- */
ok(r1?.lecture_seule === '25006', 'T5 la sonde ne peut pas écrire (25006)', r1?.lecture_seule || 'non observé');
ok(r1?.contexte_transactionnel?.visible_dans_la_transaction === true
  && r1?.contexte_transactionnel?.absent_apres === true,
  'T5 le contexte est TRANSACTIONNEL : visible dedans, absent après — sûr quel que soit le pooler',
  JSON.stringify(r1?.contexte_transactionnel));
ok(['session_ou_direct', 'transaction_pooling'].includes(r1?.pooler?.mode),
  'T5 le mode du pooler est mesuré par le pid, pas déduit de l URL', JSON.stringify(r1?.pooler));

/* --- T2 : rôle privilégié ------------------------------------------------- */
const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-p107-runtime-test' });
await admin.connect();
const superuser = lancer(['--url', urlAdmin, '--json']);
const r2 = json(superuser);
ok(superuser.status === 1 && r2?.verdict === 'ARRET',
  'T2 un rôle SUPERUSER est REFUSÉ (code 1)', `${superuser.status} arrêts=${(r2?.arrets || []).length}`);
for (const motif of ['SUPERUSER', 'BYPASSRLS', 'CREATEROLE', 'CREATEDB']) {
  ok((r2?.arrets || []).some((a) => a.includes(motif)),
    `T2 l attribut ${motif} est nommé dans les arrêts`, (r2?.arrets || []).join(' | ').slice(0, 80));
}

/* --- T3 : escalade par appartenance -------------------------------------- */
const sonde = `tf_p107_rt_${randomBytes(3).toString('hex')}`;
const mdpSonde = randomBytes(12).toString('hex');
const urlSonde = new URL(urlAdmin);
urlSonde.username = sonde;
urlSonde.password = mdpSonde;
let verrou = null;
try {
  verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
  await admin.query(`CREATE ROLE ${sonde} LOGIN PASSWORD '${mdpSonde}' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS`);
  await admin.query(`GRANT CONNECT ON DATABASE ${admin.database ? `"${admin.database}"` : 'postgres'} TO ${sonde}`);
  await admin.query(`GRANT tracefab_migrator TO ${sonde}`);

  const escalade = lancer(['--url', urlSonde.toString(), '--json', '--role-attendu', sonde]);
  const r3 = json(escalade);
  ok(escalade.status === 1,
    'T3 un rôle SANS attribut privilégié mais MEMBRE d un rôle privilégié est REFUSÉ (code 1)',
    `code ${escalade.status}`);
  ok((r3?.arrets || []).some((a) => a.includes('peut prendre tracefab_migrator')),
    'T3 l escalade est nommée (SET ROLE effectif), pas seulement l appartenance',
    (r3?.arrets || []).find((a) => a.includes('peut prendre')) || 'absente');

  await admin.query(`REVOKE tracefab_migrator FROM ${sonde}`);
  const sansEscalade = lancer(['--url', urlSonde.toString(), '--json', '--role-attendu', sonde]);
  ok(sansEscalade.status === 0,
    'T3 appartenance retirée : le même rôle redevient conforme — le refus venait bien de l appartenance',
    `code ${sansEscalade.status}`);
} finally {
  await admin.query(`REVOKE tracefab_migrator FROM ${sonde}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${sonde}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${sonde}`).catch(() => {});
  if (verrou) await verrou.relacher();
}

/* --- T4 : la clé, jamais la valeur -------------------------------------- */
const cleValide = 'cd'.repeat(32);
const avecCle = json(lancer(['--url', urlApp, '--json'], { TRACEFAB_IDENTITY_KEY: cleValide }));
ok(avecCle?.cle_identite === 'valide', 'T4 une clé au bon format est annoncée « valide »', avecCle?.cle_identite);
const sortieCle = JSON.stringify(avecCle || {});
ok(!sortieCle.includes(cleValide) && !sortieCle.includes(cleValide.slice(0, 16)),
  'T4 la valeur de la clé n apparaît JAMAIS dans le rapport');

const avecCleInvalide = json(lancer(['--url', urlApp, '--json'], { TRACEFAB_IDENTITY_KEY: 'pas-une-cle-hexa' }));
ok(avecCleInvalide?.cle_identite === 'invalide'
  && (avecCleInvalide?.arrets || []).some((a) => a.includes('malformée')),
  'T4 une clé PRÉSENTE mais malformée est signalée comme un ARRÊT, pas comme une absence',
  `${avecCleInvalide?.cle_identite} · ${(avecCleInvalide?.arrets || []).join(' | ')}`);

const sansCle = json(lancer(['--url', urlApp, '--json'], { TRACEFAB_IDENTITY_KEY: '' }));
ok(sansCle?.cle_identite === 'absente' && sansCle?.observation !== undefined,
  'T4 une clé absente est annoncée comme TRANSITION, pas comme sécurité',
  sansCle?.observation || 'observation absente');

/* --- T6 : refus de cible ------------------------------------------------ */
const distant = lancer(['--url', 'postgresql://x:y@exemple.invalid:5432/base']);
ok(distant.status === 3 && /REFUS — cible non locale/.test(distant.stderr),
  'T6 une cible distante sans opt-in explicite est REFUSÉE (code 3)', `code ${distant.status}`);
const sansUrl = spawnSync(process.execPath, [LANCEUR], { encoding: 'utf8', env: { ...process.env, TRACEFAB_RUNTIME_URL: '' } });
ok(sansUrl.status === 2, 'T6 sans URL, la sonde sort en 2 (non exécutée), jamais en 0', `code ${sansUrl.status}`);

await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  Sonde runtime P10.7 : ${assertions} assertions — témoins négatifs ET positifs.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
