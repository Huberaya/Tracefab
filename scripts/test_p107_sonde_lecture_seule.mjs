#!/usr/bin/env node
/**
 * P10.7 — LA SONDE D'ÉTAT CIBLE EST-ELLE VRAIMENT EN LECTURE SEULE, ET DIT-ELLE
 * VRAIMENT QUELQUE CHOSE ?
 *
 * Un document de sonde se dégrade sans qu'on le remarque : une ligne ajoutée
 * pour « vérifier » un GRANT, un `UPDATE` de confort, et la sonde devient une
 * modification de la production. Le dépôt a déjà ce garde-fou pour la sonde
 * P10.5 (`test:p105:sonde`) ; celui-ci fait de même pour P10.7, et ajoute ce
 * que P10.5 ne pouvait pas faire : la preuve que les ARRÊTS se déclenchent.
 *
 * CE QUE CE TEST PROUVE
 *
 *   S1 STATIQUE — chaque instruction commence par SELECT ou WITH : aucune
 *      écriture n'est possible par construction, pas « par relecture ».
 *   S2 DYNAMIQUE — toutes les sections s'exécutent sans erreur sur une base
 *      migrée (70 migrations), et le lanceur prouve le refus d'écriture (25006).
 *   S3 IDEMPOTENCE — deux exécutions rendent le même ÉTAT (horodatages
 *      neutralisés) : la sonde ne modifie rien, elle mesure.
 *   S4 TÉMOIN NÉGATIF — un rôle de connexion qui ATTEINT un rôle privilégié
 *      fait sortir la sonde en 1 avec un arrêt nommé. Sans ce témoin, on ne
 *      saurait pas si la détection fonctionne : un contrôle qui ne se déclenche
 *      jamais ne prouve rien.
 *   S5 TÉMOIN POSITIF — le même rôle, une fois l'appartenance retirée, ne
 *      produit plus d'arrêt : le refus venait bien de l'appartenance.
 *   S6 REFUS DE CIBLE — hors localhost sans opt-in explicite, la sonde refuse
 *      de démarrer (3) : on ne lit pas une base distante par inadvertance.
 *   S7 AUCUN SECRET — l'environnement est pollué par une clé d'identité
 *      factice : elle ne doit apparaître nulle part dans la sortie.
 *
 * Env : DATABASE_URL (base jetable migrée). Sortie : 0 conforme · 1 régression.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { verrouillerCluster } from './lib/ephemeral-db.mjs';

const CHEMIN_SONDE = 'docs/security/2026-11-02-p107-sonde-identite-et-etat-cible.sql';
const LANCEUR = 'scripts/sonde_p107_etat_cible.mjs';
const url = (process.env.DATABASE_URL || '').trim();
if (!url) {
  console.error('  NON EXECUTE — DATABASE_URL est requise (base jetable migrée).');
  process.exit(2);
}

let assertions = 0;
let echecs = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

/* --- S1 : contrôle statique ---------------------------------------------- */
const source = readFileSync(CHEMIN_SONDE, 'utf8');
const sansCommentaires = source.replace(/--[^\n]*/g, '');
const instructions = sansCommentaires.split(';').map((s) => s.trim()).filter(Boolean);
const nonSelect = instructions.filter((s) => !/^(select|with)\b/i.test(s));
ok(instructions.length >= 10, 'S1 la sonde porte toutes ses sections', `${instructions.length} instructions`);
ok(nonSelect.length === 0,
  'S1 chaque instruction commence par SELECT ou WITH — aucune écriture possible par construction',
  nonSelect.length ? nonSelect[0].slice(0, 60) : 'aucune exception');
ok(!/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|grant\s+|revoke\s+|alter\s+\w|drop\s+\w|create\s+(table|role|function|policy))\b/i
  .test(sansCommentaires),
  'S1 aucun mot-clé d écriture ou de DDL dans le code exécuté');

/* --- S2 : exécution réelle, refus d'écriture prouvé ---------------------- */
const env = { ...process.env, TRACEFAB_IDENTITY_KEY: 'ab'.repeat(32) };
const lancer = (args) => spawnSync(process.execPath, [LANCEUR, ...args], { encoding: 'utf8', env });

const premier = lancer(['--url', url, '--json']);
ok(premier.status === 0, 'S2 la sonde s exécute sans arrêt sur une base migrée', `code ${premier.status}`);
let rapport = null;
try { rapport = JSON.parse(premier.stdout); } catch { rapport = null; }
ok(Boolean(rapport), 'S2 la sortie est un rapport exploitable (JSON)');
ok(rapport?.lecture_seule_prouvee === '25006',
  'S2 le moteur REFUSE une écriture dans la transaction de la sonde (25006)', rapport?.lecture_seule_prouvee || 'non observé');
ok(rapport?.test_lecture_seule?.verdict === 'TENTATIVE_ECRITURE_REFUSEE'
    && rapport?.test_lecture_seule?.sqlstate === '25006',
  'S2 le verdict de lecture seule repose sur le SQLSTATE 25006, pas sur son message');
ok(rapport?.rollback_mesures_effectue === true
    && rapport?.test_lecture_seule?.rollback_effectue === true,
  'S2 les mesures et le test d écriture sont annulés dans deux transactions distinctes');
ok(rapport?.b1_historique?.en_echec === 0,
  'S2 l historique des migrations est lisible et sans échec', JSON.stringify(rapport?.b1_historique));
ok(Array.isArray(rapport?.b2_migrations_p105_p106) && rapport.b2_migrations_p105_p106.length === 2,
  'S2 les deux migrations P10.5/P10.6 sont suivies nommément',
  (rapport?.b2_migrations_p105_p106 || []).map((m) => `${m.nom.slice(0, 14)}…=${m.appliquee ? 'appliquée' : 'en attente'}`).join(' '));
ok(rapport?.b4_proprietaires?.length === 6,
  'S2 les six fonctions visées par 20261102120000 sont nommées avec leur propriétaire',
  `${rapport?.b4_proprietaires?.length ?? 0}/6`);
ok(rapport?.verdict === 'AUCUN_ARRET_DETECTE',
  'S2 aucune condition d arrêt sur une base conforme', (rapport?.arrets || []).join(' | ') || 'aucune');

/* --- S7 : aucun secret dans la sortie ------------------------------------ */
const cleFactice = env.TRACEFAB_IDENTITY_KEY;
ok(!premier.stdout.includes(cleFactice) && !premier.stderr.includes(cleFactice),
  'S7 la clé d identité factice n apparaît jamais dans la sortie de la sonde');

/* --- S3 : idempotence (l'état, pas l'heure) ------------------------------ */
const neutraliser = (texte) => texte
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<horodatage>');
const second = lancer(['--url', url, '--json']);
ok(neutraliser(premier.stdout) === neutraliser(second.stdout),
  'S3 deux exécutions rendent le même état — la sonde ne modifie rien');

/* --- S4/S5 : témoins d'arrêt -------------------------------------------- */
const admin = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-p107-sonde-test' });
await admin.connect();
const sonde = `tf_p107_sonde_${randomBytes(3).toString('hex')}`;
let verrou = null;
try {
  verrou = await verrouillerCluster({ urlProprietaire: url });
  await admin.query(`CREATE ROLE ${sonde} LOGIN PASSWORD '${randomBytes(12).toString('hex')}' NOSUPERUSER NOCREATEROLE NOCREATEDB`);
  await admin.query(`GRANT tracefab_migrator TO ${sonde}`);

  const avecEscalade = lancer(['--url', url, '--json', '--role-runtime', sonde]);
  const rapportEscalade = (() => { try { return JSON.parse(avecEscalade.stdout); } catch { return null; } })();
  const arretA3 = (rapportEscalade?.arrets || []).some((a) => a.startsWith('A3'));
  ok(avecEscalade.status === 1 && arretA3,
    'S4 un rôle de connexion atteignant un rôle privilégié déclenche l ARRÊT A3 (code 1)',
    `code ${avecEscalade.status} · arrêts=${(rapportEscalade?.arrets || []).length}`);

  const arretA4 = (rapportEscalade?.arrets || []).some((a) => a.startsWith('A4'));
  ok(arretA4, 'S4 la capacité EFFECTIVE de prendre le rôle est aussi signalée (A4)',
    (rapportEscalade?.arrets || []).find((a) => a.startsWith('A4')) || 'absente');

  await admin.query(`REVOKE tracefab_migrator FROM ${sonde}`);
  const sansEscalade = lancer(['--url', url, '--json', '--role-runtime', sonde]);
  ok(sansEscalade.status === 0,
    'S5 appartenance retirée : plus d arrêt — le refus venait bien de l appartenance',
    `code ${sansEscalade.status}`);
} finally {
  await admin.query(`REVOKE tracefab_migrator FROM ${sonde}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${sonde}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${sonde}`).catch(() => {});
  if (verrou) await verrou.relacher();
  await admin.end();
}

/* --- S6 : refus de cible distante ---------------------------------------- */
const distant = lancer(['--url', 'postgresql://x:y@exemple.invalid:5432/base']);
ok(distant.status === 3 && /REFUS — cible non locale/.test(distant.stderr),
  'S6 une cible distante sans opt-in explicite est REFUSÉE (code 3)', `code ${distant.status}`);

console.log('');
if (echecs === 0) {
  console.log(`  Sonde P10.7 : ${assertions} assertions — lecture seule prouvée, arrêts prouvés.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
