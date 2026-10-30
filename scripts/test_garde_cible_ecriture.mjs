#!/usr/bin/env node
/**
 * R3 — les trois scripts DPP hors lanceur passent par le CLASSIFIEUR.
 *
 * CE QUI ETAIT FAUX
 *
 * `test_dpp_role_applicatif.mjs`, `valider_branche_dpp.mjs` et
 * `mesure_effet_migrations_dpp.mjs` ecrivent en base et sont invoques
 * DIRECTEMENT par `package.json` (`npm run test:dpp:role-applicatif`,
 * `test:dpp:branche`, `db:mesure-dpp`) : ils ne passent donc pas par
 * `scripts/run-db-suite.mjs`, ni par sa garde. Chacun portait sa propre liste
 * noire : UN nom d'hote de production, ecrit en dur, surchargeable par
 * `TF_HOTE_PRODUCTION`. Tout le reste etait accepte — y compris une autre base
 * Neon, une base locale qui n'est pas de test, ou un `?host=` dans la chaine.
 *
 * CE QUE CE TEST PROUVE
 *
 *   A. le classifieur refuse, pour les cinq familles exigees :
 *        — URL de production (Neon, nom d'hote de production) ;
 *        — URL Neon quelconque (hote manage, jamais jetable) ;
 *        — base locale non jetable (nom evoquant la production, `hostaddr`,
 *          `host=` ambigu) ;
 *        — variables d'environnement CONTRADICTOIRES (deux bases differentes) ;
 *        — identite de CLUSTER inattendue (`TF_SYSID_ATTENDU`).
 *   B. les trois scripts, lances avec une cible refusee, sortent en 3 (ou 2 si
 *      la variable obligatoire manque) SANS RIEN ECRIRE : une base locale
 *      refusee par son nom est preparee avec une table canari, le script est
 *      lance, la table ET sa ligne sont intactes apres coup.
 *   C. le cas nominal reste ouvert : la meme garde accepte une cible jetable,
 *      et `TF_SYSID_ATTENDU` conforme est accepte.
 *   D. aucune des trois sources ne contient plus de liste noire ni de lecture de
 *      `TF_HOTE_PRODUCTION`.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { deriverUrl } from './lib/ephemeral-db.mjs';
import {
  EXIT_CIBLE_REFUSEE,
  EXIT_NON_EXECUTE,
  classerCibles,
  exigerCibleEcriture,
  verifierIdentiteCluster,
} from './lib/garde_cible_ecriture.mjs';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));

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
  purpose: 'garde des scripts DPP hors lanceur',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;

async function connexion(url) {
  const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await c.connect();
  return c;
}

async function adm() {
  return connexion(deriverUrl(urlProprietaire, 'postgres'));
}

async function sysid() {
  const c = await adm();
  try {
    const { rows } = await c.query('SELECT system_identifier FROM pg_control_system()');
    return String(rows[0].system_identifier);
  } finally {
    await c.end();
  }
}

const IDENTITE = await sysid();

/** Lance une classification avec un environnement donne, sans toucher au mien. */
function classerAvec(env, options) {
  const sauve = {};
  for (const cle of Object.keys(env)) {
    sauve[cle] = process.env[cle];
    if (env[cle] === undefined) delete process.env[cle];
    else process.env[cle] = env[cle];
  }
  try {
    return classerCibles(options);
  } finally {
    for (const cle of Object.keys(sauve)) {
      if (sauve[cle] === undefined) delete process.env[cle];
      else process.env[cle] = sauve[cle];
    }
  }
}

/* ========================================================================== *
 * A. Le classifieur refuse les cinq familles exigees
 * ========================================================================== */

console.log('\n  A. famille 1 et 2 — URL de production et URL Neon');

const NEON_PROD = 'postgresql://u:p@ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech/neondb';
const NEON_AUTRE = 'postgresql://u:p@ep-autre-branche-123456.eu-central-1.aws.neon.tech/neondb';
for (const [libelle, url] of [['production Neon', NEON_PROD], ['Neon quelconque', NEON_AUTRE]]) {
  const v = classerAvec({ DATABASE_URL: url, TF_RLS_APP_URL: undefined });
  verifier(`${libelle} refusee`, !v.ok && v.code === 'managed_host', `${v.code} — ${v.raison}`);
}

console.log('\n  A2. famille 3 — base locale non jetable');

for (const [libelle, url, code] of [
  ['nom evoquant la production', 'postgresql://postgres@127.0.0.1:5432/tracefab_prod', 'production_name'],
  ['parametre hostaddr', 'postgresql://postgres@127.0.0.1:5432/tracefab_test?hostaddr=10.0.0.1', 'hostaddr_param'],
  ['deux valeurs host=', 'postgresql://postgres@127.0.0.1/tracefab_test?host=a&host=b', 'ambiguous_host_param'],
]) {
  const v = classerAvec({ DATABASE_URL: url, TF_RLS_APP_URL: undefined });
  verifier(`refus : ${libelle}`, !v.ok && v.code === code, `${v.code} — ${v.raison}`);
}

console.log('\n  A3. famille 4 — variables contradictoires');

{
  const url1 = deriverUrl(urlProprietaire, 'tracefab_test');
  const url2 = deriverUrl(urlProprietaire, 'autre_base_locale');
  const v = classerAvec({ DATABASE_URL: url1, TF_RLS_APP_URL: url2 },
    { variables: ['TF_RLS_APP_URL', 'DATABASE_URL'], requise: 'TF_RLS_APP_URL' });
  verifier('deux bases jetables mais DIFFERENTES sont refusees',
    !v.ok && v.code === 'contradictory_variables', `${v.code} — ${v.raison}`);

  const meme = classerAvec({ DATABASE_URL: url1, TF_RLS_APP_URL: url1 },
    { variables: ['TF_RLS_APP_URL', 'DATABASE_URL'], requise: 'TF_RLS_APP_URL' });
  verifier('la meme base dans les deux variables est acceptee', meme.ok, meme.raison);
}

console.log('\n  A4. famille 5 — identite de cluster inattendue');

{
  const url = deriverUrl(urlProprietaire, 'tracefab_test');
  const bon = await verifierIdentiteCluster({ url, attendu: IDENTITE });
  verifier('identite exigee et conforme : acceptee', bon.ok && bon.code === 'identity_ok', bon.raison);

  const mauvais = await verifierIdentiteCluster({ url, attendu: '0000000000000000000' });
  verifier('identite differente : refusee', !mauvais.ok && mauvais.code === 'unexpected_cluster',
    mauvais.raison);

  const illisible = await verifierIdentiteCluster({ url, attendu: '123' });
  verifier('identite exigee et MESUREE differente : jamais « acceptee par defaut »',
    !illisible.ok, illisible.code);

  // Identite ILLISIBLE : la garde ne peut pas la mesurer. On exige quand meme
  // une identite (cible locale jetable mais port ferme) : la garde doit REFUSER,
  // parce qu'une verite non etablie n'est pas une autorisation.
  const injoignable = 'postgresql://postgres@127.0.0.1:55499/tracefab_test';
  const r = await verifierIdentiteCluster({ url: injoignable, attendu: IDENTITE });
  verifier('identite illisible alors qu elle est exigee : refusee',
    !r.ok && r.code === 'identity_unreadable', `${r.code} — ${r.raison}`);
}

console.log('\n  A5. variable obligatoire absente : non execute, pas « accepte »');

{
  const v = classerAvec({ DATABASE_URL: undefined, TF_RLS_APP_URL: undefined },
    { variables: ['DATABASE_URL'], requise: 'DATABASE_URL' });
  verifier('variable absente : code missing', !v.ok && v.code === 'missing', v.code);

  // `exigerCibleEcriture` lit `process.env` : on retire reellement la variable
  // le temps de l'appel, sinon on testerait la cible du lanceur.
  let leve = null;
  const sauve = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await exigerCibleEcriture({ variables: ['DATABASE_URL'], requise: 'DATABASE_URL', exitOnFailure: false });
  } catch (e) {
    leve = e;
  } finally {
    if (sauve !== undefined) process.env.DATABASE_URL = sauve;
  }
  verifier('variable absente : levee de refus (pas de poursuite)',
    leve !== null && leve.exitCode === EXIT_NON_EXECUTE, leve ? String(leve.exitCode) : 'aucune levee');
}

/* ========================================================================== *
 * B. Aucune ecriture quand la garde refuse
 * ========================================================================== */

console.log('\n  B. les trois scripts sortent sans ecrire sur une cible refusee');

// Une base locale que le classifieur REFUSE (nom evoquant la production), avec
// une table canari : si un script ecrivait, on le verrait ici.
const BASE_REFUSEE = 'tracefab_prod';
const CANARI = 'canari_r3';
const comptes = {};

{
  const a = await adm();
  try {
    const { rows } = await a.query('SELECT 1 FROM pg_database WHERE datname = $1', [BASE_REFUSEE]);
    if (rows.length > 0) {
      throw new Error(`la base ${BASE_REFUSEE} existe deja : ce test ne doit pas la toucher`);
    }
    await a.query(`CREATE DATABASE ${BASE_REFUSEE}`);
  } finally {
    await a.end();
  }
}

const urlRefusee = deriverUrl(urlProprietaire, BASE_REFUSEE);
{
  const c = await connexion(urlRefusee);
  try {
    await c.query(`CREATE TABLE ${CANARI} (note text)`);
    await c.query(`INSERT INTO ${CANARI} VALUES ('avant')`);
  } finally {
    await c.end();
  }
}

function lancer(script, args, env, retirer = []) {
  // `retirer` existe parce qu'une valeur `undefined` dans l'objet `env` de
  // `spawnSync` ne supprime rien : l'enfant recoit la chaine « undefined »,
  // qui est classee « non analysable » (donc refusee) au lieu d' « absente ».
  const enfantEnv = { ...process.env, ...env };
  for (const cle of retirer) delete enfantEnv[cle];
  const r = spawnSync(process.execPath, [join(RACINE, script), ...args], {
    cwd: RACINE, encoding: 'utf8', env: enfantEnv,
  });
  return { code: r.status, sortie: `${r.stdout || ''}${r.stderr || ''}` };
}

// Environnement commun : on neutralise ce que le shell a pu poser.
const ENV_NEUTRE = {
  DATABASE_URL: undefined, TF_RLS_APP_URL: undefined, TF_SYSID_ATTENDU: undefined,
  TF_HOTE_PRODUCTION: undefined,
};
function envAvec(surcharges) {
  const e = {};
  for (const [k, v] of Object.entries({ ...ENV_NEUTRE, ...surcharges })) {
    if (v !== undefined) e[k] = v;
  }
  return e;
}

for (const [script, args, env] of [
  ['scripts/test_dpp_role_applicatif.mjs', [], envAvec({ TF_RLS_APP_URL: urlRefusee })],
  ['scripts/valider_branche_dpp.mjs', ['--dry-run'], envAvec({ DATABASE_URL: urlRefusee })],
  ['scripts/mesure_effet_migrations_dpp.mjs', ['--dry-run'], envAvec({ DATABASE_URL: urlRefusee })],
]) {
  const r = lancer(script, args, env);
  verifier(`${script.split('/').pop()} refuse la cible (exit ${EXIT_CIBLE_REFUSEE})`,
    r.code === EXIT_CIBLE_REFUSEE, `exit=${r.code} · ${r.sortie.trim().split('\n').slice(-2).join(' | ')}`);
  verifier(`${script.split('/').pop()} n affiche ni URL ni hote complets`,
    !/postgres(ql)?:\/\//.test(r.sortie), 'une chaine de connexion figure dans la sortie');
}

{
  const c = await connexion(urlRefusee);
  try {
    const { rows } = await c.query(`SELECT count(*)::int n FROM ${CANARI}`);
    comptes.canari = rows[0].n;
  } finally {
    await c.end();
  }
}
verifier('la table canari est intacte apres les trois refus (aucune ecriture)',
  comptes.canari === 1, `${comptes.canari} ligne(s)`);

// Meme preuve avec une cible Neon : les scripts doivent refuser AVANT toute
// tentative de connexion (sinon le test echouerait sur un timeout reseau).
for (const [script, env] of [
  ['scripts/valider_branche_dpp.mjs', envAvec({ DATABASE_URL: NEON_PROD })],
  ['scripts/mesure_effet_migrations_dpp.mjs', envAvec({ DATABASE_URL: NEON_AUTRE })],
]) {
  const debut = Date.now();
  const r = lancer(script, ['--dry-run'], env);
  const duree = Date.now() - debut;
  verifier(`${script.split('/').pop()} refuse une cible Neon sans tenter de connexion`,
    r.code === EXIT_CIBLE_REFUSEE && duree < 5000, `exit=${r.code} en ${duree} ms`);
}

console.log('\n  B2. identite de cluster exigee : refus avant ecriture');

{
  const url = deriverUrl(urlProprietaire, 'tracefab_test');
  const r = lancer('scripts/valider_branche_dpp.mjs', ['--dry-run'],
    envAvec({ DATABASE_URL: url, TF_SYSID_ATTENDU: '0000000000000000000' }));
  verifier('identite inattendue : le script refuse (exit 3)',
    r.code === EXIT_CIBLE_REFUSEE, `exit=${r.code}`);
  verifier('le refus nomme le cluster, sans divulguer la chaine',
    /identite de cluster inattendue/.test(r.sortie) && !/postgres(ql)?:\/\//.test(r.sortie),
    r.sortie.trim().split('\n').slice(-3, -2).join(''));
}

/* ========================================================================== *
 * B3. Les neuf scripts a garde d'IMPORT refusent sans ecrire
 * ========================================================================== */

console.log('\n  B3. neuf scripts hors lanceur : garde evaluee a l import, aucun ecriture');

// Ces neuf scripts (quatre `apply_migration_chantier*` et cinq `test_neon_*`)
// n'etaient couverts par AUCUNE garde avant le 30/10 : ils ecrivent (DDL,
// roles, donnees) et sont invoques a la main. Le garde est importe en PREMIERE
// position du fichier, donc evalue avant tout autre import — y compris avant
// les modules qui construisent un client Prisma.
const SCRIPTS_GARDE_IMPORT = [
  'apply_migration_chantier2', 'apply_migration_chantier3',
  'apply_migration_chantier4', 'apply_migration_chantier5',
  'test_neon_bulk_operations_chantier8', 'test_neon_chantier7_mass_balance',
  'test_neon_document_ai', 'test_neon_plm_erp_gs1', 'test_neon_supplier_advanced',
];

function compterCanari() {
  return connexion(urlRefusee).then(async (c) => {
    try {
      const { rows } = await c.query(`SELECT count(*)::int n FROM ${CANARI}`);
      return rows[0].n;
    } finally {
      await c.end();
    }
  });
}

const canariAvant = await compterCanari();
const resultats = [];
for (const nom of SCRIPTS_GARDE_IMPORT) {
  const script = `scripts/${nom}.mjs`;

  // 3) hote manage : refus sans tentative de connexion (sinon timeout reseau).


  // 1) cible non jetable, designee par son nom, sur un cluster joignable :
  //    le refus doit tomber AVANT la connexion, donc sans ecriture.
  const refuse = lancer(script, [], envAvec({ DATABASE_URL: urlRefusee }));
  verifier(`${nom} : cible non jetable refusee (exit ${EXIT_CIBLE_REFUSEE})`,
    refuse.code === EXIT_CIBLE_REFUSEE,
    `exit=${refuse.code} · ${refuse.sortie.trim().split('\n').slice(-2).join(' | ')}`);
  verifier(`${nom} : le refus n affiche aucune chaine de connexion`,
    !/postgres(ql)?:\/\//.test(refuse.sortie), 'une chaine figure dans la sortie');

  // 2) variable absente : rien a faire, donc rien execute (sortie 2).
  const absent = lancer(script, [], {}, ['DATABASE_URL', 'TF_RLS_APP_URL']);
  verifier(`${nom} : variable absente (exit ${EXIT_NON_EXECUTE}, pas « passe »)`,
    absent.code === EXIT_NON_EXECUTE,
    `exit=${absent.code} · ${absent.sortie.trim().split('\n').slice(-1).join('')}`);

  // 3) hote manage : refus sans tentative de connexion (sinon timeout reseau).

  const debut = Date.now();
  const neon = lancer(script, [], envAvec({ DATABASE_URL: NEON_PROD }));
  const duree = Date.now() - debut;
  verifier(`${nom} : cible Neon refusee sans tenter de connexion`,
    neon.code === EXIT_CIBLE_REFUSEE && duree < 5000, `exit=${neon.code} en ${duree} ms`);

  // 4) configuration incoherente : la cible est jetable, mais le contexte de
  //    deploiement annonce la production. Un contexte contradictoire n'est pas
  //    une autorisation.
  const incoherent = lancer(script, [], {
    ...envAvec({ DATABASE_URL: deriverUrl(urlProprietaire, 'tracefab_test') }),
    NODE_ENV: 'production',
  });
  verifier(`${nom} : configuration incoherente refusee (contexte production)`,
    incoherent.code === EXIT_CIBLE_REFUSEE,
    `exit=${incoherent.code} · ${incoherent.sortie.trim().split('\n').slice(-1).join('')}`);

  resultats.push({ nom, refuse: refuse.code, absent: absent.code, neon: neon.code, incoherent: incoherent.code });
}

const canariApres = await compterCanari();
verifier('la table canari est intacte apres 36 lancements refuses (aucune ecriture)',
  canariApres === canariAvant && canariApres === 1, `${canariAvant} avant, ${canariApres} apres`);

// Aucun refus ne doit laisser de role de sonde derriere lui : les quatre
// `apply_migration_*` et les cinq `test_neon_*` creent des roles temporaires
// une fois autorises, jamais avant.
{
  const c = await connexion(deriverUrl(urlProprietaire, 'tracefab_test'));
  try {
    const { rows } = await c.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'tf\\_%'");
    verifier('aucun role tf_* cree par les lancements refuses', rows.length === 0,
      rows.map((x) => x.rolname).join(', '));
  } finally {
    await c.end();
  }
}

console.log('\n  B4. ordre d evaluation : la garde precede tout autre import');

for (const nom of SCRIPTS_GARDE_IMPORT) {
  const source = readFileSync(join(RACINE, 'scripts', `${nom}.mjs`), 'utf8');
  const imports = source.split('\n')
    .map((ligne, index) => ({ ligne, index }))
    .filter(({ ligne }) => /^\s*import\s/.test(ligne) && !/^\s*import\s*\(/.test(ligne));
  verifier(`${nom} : premier import = garde_import.mjs (aucun module evalue avant)`,
    imports.length > 0 && /^import '\.\/lib\/garde_import\.mjs';$/.test(imports[0].ligne.trim()),
    imports.length > 0 ? imports[0].ligne.trim() : 'aucun import statique');
  verifier(`${nom} : un seul new PrismaClient (pas de chemin de connexion oublie)`,
    (source.match(/new PrismaClient\(/g) || []).length <= 1,
    `${(source.match(/new PrismaClient\(/g) || []).length} occurrences`);
}

/* ========================================================================== *
 * C. Le cas nominal reste ouvert
 * ========================================================================== */

console.log('\n  C. une cible jetable reste acceptee');

{
  const url = deriverUrl(urlProprietaire, 'tracefab_test');
  const r = await exigerCibleEcriture({
    variables: ['DATABASE_URL'], requise: 'DATABASE_URL',
    attenduSysid: IDENTITE, exitOnFailure: false,
    purpose: 'cas nominal',
  });
  verifier('cible jetable + identite conforme : acceptee',
    r.verdict.allowed === true && r.identite.systemIdentifier === IDENTITE, r.verdict.code);
}

/* ========================================================================== *
 * D. Plus aucune liste noire dans les trois sources
 * ========================================================================== */

console.log('\n  D. les listes noires ont disparu des trois scripts');

for (const script of ['scripts/test_dpp_role_applicatif.mjs', 'scripts/valider_branche_dpp.mjs',
  'scripts/mesure_effet_migrations_dpp.mjs']) {
  const source = readFileSync(join(RACINE, script), 'utf8');
  const code = source.split('\n').filter((l) => !l.trimStart().startsWith('*')
    && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('/*'));
  verifier(`${script.split('/').pop()} importe la garde commune`,
    /from '\.\/lib\/garde_cible_ecriture\.mjs'/.test(source), 'import absent');
  verifier(`${script.split('/').pop()} appelle exigerCibleEcriture`,
    /exigerCibleEcriture\(/.test(source), 'appel absent');
  verifier(`${script.split('/').pop()} ne lit plus TF_HOTE_PRODUCTION`,
    !code.some((l) => /TF_HOTE_PRODUCTION/.test(l)), 'liste noire encore presente');
  verifier(`${script.split('/').pop()} n a plus de comparaison d hote en dur`,
    !code.some((l) => /ep-polished-night/.test(l)), 'nom de production encore code en dur');
}

/* ========================================================================== *
 * Nettoyage
 * ========================================================================== */

console.log('\n  E. le test range ce qu il a cree');

{
  const a = await adm();
  try {
    await a.query(`DROP DATABASE IF EXISTS ${BASE_REFUSEE} WITH (FORCE)`);
    const { rows: b } = await a.query(
      "SELECT datname FROM pg_database WHERE datname = $1", [BASE_REFUSEE],
    );
    verifier('la base canari a ete detruite', b.length === 0, BASE_REFUSEE);
    const { rows: r } = await a.query(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'tf_garde_sysid%'",
    );
    verifier('aucun role de sonde residuel', r.length === 0, r.map((x) => x.rolname).join(', '));
  } finally {
    await a.end();
  }
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — les trois scripts DPP passent par le classifieur, et refusent sans ecrire.\n');
process.exit(0);
