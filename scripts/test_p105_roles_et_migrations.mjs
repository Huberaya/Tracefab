#!/usr/bin/env node
/**
 * P10.5 — B2 et B3 : la chaîne de migrations tourne avec un rôle dédié, sans
 * SUPERUSER, et le runtime ne peut ni migrer ni s'élever.
 *
 * CE QUE CE TEST ÉPROUVE, ET POURQUOI CHAQUE POINT COMPTE
 *
 *   B2.1  68/68 migrations sur une base VIERGE, exécutées par
 *         `tracefab_migrator` — un rôle `NOSUPERUSER` qui possède les objets.
 *   B2.2  reprise : relancer ne rejoue rien et ne casse rien.
 *   B2.3  `tracefab_app` ne peut PAS exécuter de migration (42501).
 *   B2.4  `tracefab_app` ne peut PAS prendre le rôle propriétaire ni le rôle
 *         de migration (`SET ROLE` refusé, essayé pour de vrai).
 *   B2.5  aucun privilège injustifié : ni SUPERUSER, ni BYPASSRLS sur le
 *         runtime ; le rôle de migration ne porte que ce que la chaîne exige,
 *         et il est prouvé NON superutilisateur à la fin.
 *   B3.1  le provisioning d'un rôle DÉJÀ CONFORME n'émet aucun `ALTER ROLE` —
 *         c'est ce qui permet à l'application et à la CI de démarrer sans
 *         privilège d'administration (mesuré : PostgreSQL 16+ exige SUPERUSER
 *         pour changer l'attribut SUPERUSER).
 *   B3.2  un rôle NON conforme (BYPASSRLS) est REFUSÉ, pas rabattu en silence.
 *   B3.3  l'élévation temporaire de la migration assistée est révoquée et
 *         vérifiée : le rôle de migration finit `rolsuper = false`.
 *
 * La base créée est détruite à la fin. Les rôles sont des objets de CLUSTER :
 * ils restent, conformes, pour les suites suivantes.
 *
 * Sortie : 0 conforme · 1 régression · 2 non exécuté · 3 refus.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { ROLE_APP, ROLE_MIGRATOR, ROLE_WORKER, etatRole } from './lib/tracefab_roles.mjs';
import { verrouillerCluster } from './lib/ephemeral-db.mjs';
import { diagnosticProvisionnement } from './lib/diagnostic_provisionnement.mjs';

const urlAdmin = (process.env.DATABASE_URL || '').trim();
if (!urlAdmin) {
  console.error('  NON EXECUTE — DATABASE_URL est requise (compte capable de créer une base).');
  process.exit(2);
}
const hote = (() => { try { return new URL(urlAdmin).hostname; } catch { return ''; } })();
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote)) {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}). Ce test crée une base et des rôles.`);
  process.exit(3);
}

const suffixe = Math.random().toString(36).slice(2, 8);
const base = `tf_p105_${suffixe}`;
const MDP_APP = `app_${suffixe}`;
const MDP_MIG = `mig_${suffixe}`;

const url = (nom) => {
  const u = new URL(urlAdmin);
  u.pathname = `/${base}`;
  u.username = nom;
  u.password = nom === ROLE_APP ? MDP_APP : MDP_MIG;
  return u.toString();
};

let echecs = 0;
let assertions = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};
const lancer = (args, env) => spawnSync(process.execPath, args, {
  env: { ...process.env, ...env },
  encoding: 'utf8',
  cwd: process.cwd(),
});

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-p105-admin' });
await admin.connect();

console.log(`  base jetable : ${base}`);
await admin.query(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${base}`);

// Les roles sont des objets de CLUSTER : les provisionner ici change leur mot
// de passe pour tout le cluster, y compris les suites suivantes du meme job
// qui se connectent avec TF_RLS_APP_URL. Mesure du 02/11 : sans cette
// restauration, `test:p105:hmac` echouait en « password authentication failed »
// juste apres cette suite. On releve donc les verifieurs avant, et on les
// remet apres — c'est le seul etat partage que cette suite modifie.
const verifieursAvant = new Map();
for (const nom of [ROLE_APP, ROLE_MIGRATOR]) {
  const r = (await admin.query(
    'SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = $1', [nom])).rows[0];
  if (r?.rolpassword) verifieursAvant.set(nom, r.rolpassword);
}

// Verrou de CLUSTER : le provisioning ecrit dans `pg_authid`, partage par toutes
// les bases du serveur — et par toutes les suites du meme job. Meme verrou que
// les autres chemins qui provisionnent (test:jetables:verrou-cluster le verifie).
//
// Il est pris UNIQUEMENT autour du provisioning, puis relache : la suite lance
// ensuite `migrer_fidelement.mjs`, qui prend ce meme verrou dans SA session. Un
// verrou consultatif n etant pas reentrant d une session a l autre, le garder
// pendant l enfant bloquait la suite indefiniment (mesure du 02/11).
let verrou = null;

// Rôles de sonde créés par cette suite : ils sont supprimés APRÈS la
// destruction de la base, sinon `DROP ROLE` échoue sur leurs privilèges.
const rolesSondes = new Set();

let codeSortie = 0;
try {
  // -------------------------------------------------------------------------
  // B3.1 — provisioning, deux fois : la seconde ne doit RIEN émettre d'ALTER.
  // -------------------------------------------------------------------------
  const envProv = {
    DATABASE_URL: (() => { const u = new URL(urlAdmin); u.pathname = `/${base}`; return u.toString(); })(),
    TF_ALLOW_PROVISIONING: 'oui',
    TF_APP_PASSWORD: MDP_APP,
    TF_MIGRATOR_PASSWORD: MDP_MIG,
  };
  verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
  const prov1 = lancer(['scripts/provisionner_roles_db.mjs'], envProv);
  for (const ligne of diagnosticProvisionnement(prov1, 1)) console.error(`  ${ligne}`);
  ok(prov1.status === 0, 'B3.1 provisioning initial réussi', `sortie ${prov1.status}`);
  const prov2 = lancer(['scripts/provisionner_roles_db.mjs'], envProv);
  for (const ligne of diagnosticProvisionnement(prov2, 2)) console.error(`  ${ligne}`);
  ok(prov2.status === 0, 'B3.1 re-provisioning réussi (idempotent)', `sortie ${prov2.status}`);
  const alterEmis = /durci/.test(prov2.stdout);
  ok(!alterEmis, 'B3.1 le re-provisioning n émet AUCUN ALTER ROLE', alterEmis ? 'un durcissement a eu lieu' : 'aucune instruction ALTER');
  await verrou.relacher();
  verrou = null;

  // -------------------------------------------------------------------------
  // B2.1 — la chaîne complète, exécutée par le rôle de migration seul.
  // -------------------------------------------------------------------------
  const mig1 = lancer(['scripts/migrer_fidelement.mjs'], {
    DATABASE_URL: url(ROLE_MIGRATOR),
    TF_ADMIN_URL: (() => { const u = new URL(urlAdmin); u.pathname = `/${base}`; return u.toString(); })(),
    TF_ALLOW_ELEVATION: 'oui',
    TF_ALLOW_WRITE: 'oui',
  });
  const appliquees = (mig1.stdout.match(/appliquee\s+20/g) || []).length;
  ok(mig1.status === 0, 'B2.1 la chaîne s applique intégralement', `sortie ${mig1.status}, ${appliquees} appliquée(s)`);
  if (mig1.status !== 0) console.log(mig1.stdout.split('\n').filter((l) => /ECHEC|REFUS/.test(l)).join('\n'));

  const cible = new pg.Client({ connectionString: url(ROLE_MIGRATOR), ssl: sslDepuisUrl(url(ROLE_MIGRATOR)) });
  await cible.connect();
  const disque = (await cible.query(
    `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  )).rows[0].n;
  ok(disque > 0 && disque === appliquees, 'B2.1 toutes les migrations du disque sont consignées',
    `${disque} enregistrée(s)`);

  // -------------------------------------------------------------------------
  // B2.2 — reprise : rien à rejouer.
  // -------------------------------------------------------------------------
  const mig2 = lancer(['scripts/migrer_fidelement.mjs', '--etat'], { DATABASE_URL: url(ROLE_MIGRATOR) });
  ok(/Aucune migration en attente/.test(mig2.stdout), 'B2.2 reprise : aucune migration en attente',
    (mig2.stdout.match(/\d+ deja appliquee\(s\)/) || [''])[0]);

  // -------------------------------------------------------------------------
  // B2.5 — les attributs, mesurés après la chaîne.
  // -------------------------------------------------------------------------
  const etatMig = await etatRole(cible, ROLE_MIGRATOR);
  ok(etatMig?.rolsuper === false, 'B2.5 le rôle de migration n est PAS superutilisateur', `superuser=${etatMig?.rolsuper}`);
  ok(etatMig?.rolcanlogin === true, 'B2.5 le rôle de migration peut se connecter', `login=${etatMig?.rolcanlogin}`);
  const etatApp = await etatRole(cible, ROLE_APP);
  ok(etatApp?.rolsuper === false && etatApp?.rolbypassrls === false,
    'B2.5 le rôle applicatif n a ni SUPERUSER ni BYPASSRLS',
    `superuser=${etatApp?.rolsuper} bypassrls=${etatApp?.rolbypassrls}`);
  const etatWorker = await etatRole(cible, ROLE_WORKER);
  ok(etatWorker?.rolcanlogin === false && etatWorker?.rolsuper === false,
    'B2.5 le worker reste NOLOGIN et non superutilisateur',
    `login=${etatWorker?.rolcanlogin} superuser=${etatWorker?.rolsuper}`);

  const membreWorker = (await cible.query(
    `SELECT pg_catalog.pg_has_role(current_user, 'tracefab_worker', 'MEMBER') AS membre`)).rows[0];
  ok(membreWorker?.membre === false,
    'B2.5bis tracefab_migrator n est plus membre du worker après la chaîne',
    `membre=${membreWorker?.membre}`);
  let escaladeWorker = null;
  try { await cible.query('SET ROLE tracefab_worker'); escaladeWorker = 'ACCEPTE'; }
  catch (e) { escaladeWorker = e.code || 'ERREUR'; }
  ok(escaladeWorker === '42501',
    'B2.5ter tracefab_migrator ne peut pas endosser tracefab_worker', escaladeWorker);

  const urlAdminBase = new URL(urlAdmin);
  urlAdminBase.pathname = `/${base}`;
  const matrice = lancer(['livrables-finalisation/sondes/matrice-securite-roles.mjs'], {
    DATABASE_URL: urlAdminBase.toString(),
    TF_APP_MDP: MDP_APP,
    TF_MIGRATOR_MDP: MDP_MIG,
  });
  ok(matrice.status === 0, 'B2.6 matrice complète app/worker/migrator sous sessions authentifiées',
    `sortie=${matrice.status}`);
  if (matrice.status !== 0) console.log(matrice.stdout.split('\\n').filter((l) => /ECHEC|VERDICT/.test(l)).join('\\n'));
  await cible.end();

  // -------------------------------------------------------------------------
  // B2.3 et B2.4 — ce que le runtime NE PEUT PAS faire, essayé pour de vrai.
  // -------------------------------------------------------------------------
  const app = new pg.Client({ connectionString: url(ROLE_APP), ssl: sslDepuisUrl(url(ROLE_APP)) });
  await app.connect();

  let migrationParApp = null;
  try {
    await app.query('BEGIN');
    await app.query('CREATE TABLE essai_migration_par_app (id int)');
    await app.query('ROLLBACK');
    migrationParApp = 'ACCEPTÉE';
  } catch (e) {
    await app.query('ROLLBACK').catch(() => {});
    migrationParApp = `${e.code || ''} ${e.message.split('\n')[0].slice(0, 50)}`;
  }
  ok(String(migrationParApp).startsWith('42501'), 'B2.3 tracefab_app ne peut pas créer d objet (donc pas migrer)', String(migrationParApp));

  let ecritureRegistre = null;
  try {
    await app.query('BEGIN');
    await app.query(`INSERT INTO _prisma_migrations (id, checksum, migration_name, applied_steps_count) VALUES ('x','y','z',0)`);
    await app.query('ROLLBACK');
    ecritureRegistre = 'ACCEPTÉE';
  } catch (e) {
    await app.query('ROLLBACK').catch(() => {});
    ecritureRegistre = `${e.code || ''}`;
  }
  ok(ecritureRegistre === '42501', 'B2.3 tracefab_app ne peut pas écrire dans _prisma_migrations', ecritureRegistre);

  for (const nom of [ROLE_MIGRATOR, ROLE_WORKER]) {
    let pris = null;
    try {
      await app.query('BEGIN');
      await app.query(`SET ROLE ${nom}`);
      await app.query('ROLLBACK');
      pris = 'PRIS';
    } catch (e) {
      await app.query('ROLLBACK').catch(() => {});
      pris = `${e.code || ''}`;
    }
    ok(pris === '42501', `B2.4 tracefab_app ne peut pas prendre le rôle ${nom}`, pris);
  }
  await app.end();

  // -------------------------------------------------------------------------
  // B3.2 — un rôle non conforme est refusé, jamais rabattu en silence.
  // -------------------------------------------------------------------------
  const roleSonde = `tf_p105_sonde_${suffixe}`;
  await admin.query(`DROP ROLE IF EXISTS ${roleSonde}`).catch(() => {});
  await admin.query(`CREATE ROLE ${roleSonde} LOGIN BYPASSRLS NOSUPERUSER`);
  try {
    const { ensureAppRole } = await import('./lib/tracefab_app_role.mjs');
    const connexion = new pg.Client({ connectionString: (() => { const u = new URL(urlAdmin); u.pathname = `/${base}`; return u.toString(); })(), ssl: sslDepuisUrl(urlAdmin) });
    await connexion.connect();
    let refus = null;
    try {
      await ensureAppRole(connexion, 'motdepasse_quelconque', { role: roleSonde });
    } catch (e) {
      refus = `${e.name}: ${e.message.slice(0, 90)}`;
    }
    ok(/RolePreexistantRefuse/.test(String(refus)), 'B3.2 un rôle préexistant BYPASSRLS est REFUSÉ', String(refus).slice(0, 90));
    const apres = await etatRole(connexion, roleSonde);
    ok(apres?.rolbypassrls === true, 'B3.2 le rôle refusé n a pas été modifié', `bypassrls=${apres?.rolbypassrls}`);
    await connexion.end();
  } finally {
    await admin.query(`DROP OWNED BY ${roleSonde}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${roleSonde}`).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // B3.2 bis — `provisionner_roles_db.mjs` : B4 et divergence, PAR EXÉCUTION.
  //
  // Les deux refus ci-dessus portent sur `ensureAppRole`. Le script
  // d'exploitation est un CHEMIN DIFFÉRENT, et il réparait auparavant les
  // écarts d'attribut en silence dès que l'exécutant était SUPERUSER : un rôle
  // préexistant étranger voyait ses attributs réécrits par un provisionnement.
  //
  // P10.6 corrige deux choses, mesurées ici sur un rôle de SONDE (`tf_*`, jamais
  // `tracefab_app` qui est un objet de cluster partagé) :
  //   1. `verifierAucuneAppartenance` est appelée AVANT toute écriture ;
  //   2. une correction d'attribut exige `TF_CORRIGER_ATTRIBUTS=oui` ; sans ce
  //      drapeau, le script S'ARRÊTE et ne réécrit RIEN.
  // Le contrôle positif (drapeau présent -> correction appliquée) est ce qui
  // donne sa valeur au refus : sans lui, on ne saurait pas distinguer « refuse »
  // de « ne fait rien ».
  // -------------------------------------------------------------------------
  {
    const sondeApp = `tf_p106_prov_${suffixe}`;
    const parent = `tf_p106_parent_${suffixe}`;
    const envSonde = {
      ...envProv,
      TF_APP_ROLE_NAME: sondeApp,
      DATABASE_URL: (() => { const u = new URL(urlAdmin); u.pathname = `/${base}`; return u.toString(); })(),
    };
    const nettoyer = async () => {
      await admin.query(`REVOKE ${parent} FROM ${sondeApp}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${parent}`).catch(() => {});
      await admin.query(`DROP OWNED BY ${sondeApp}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${sondeApp}`).catch(() => {});
    };
    await nettoyer();
    await admin.query(`CREATE ROLE ${parent} NOLOGIN`);
    await admin.query(`CREATE ROLE ${sondeApp} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`);
    try {
      await admin.query(`GRANT ${parent} TO ${sondeApp}`);
      verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
      const refusB4 = lancer(['scripts/provisionner_roles_db.mjs'], envSonde);
      await verrou.relacher();
      verrou = null;
      ok(refusB4.status !== 0 && /B4 REFUSE/.test(refusB4.stdout + refusB4.stderr),
        'B3.2 bis provisionner_roles_db REFUSE une appartenance (B4), sortie non nulle',
        `sortie ${refusB4.status}`);

      await admin.query(`REVOKE ${parent} FROM ${sondeApp}`);
      await admin.query(`ALTER ROLE ${sondeApp} BYPASSRLS`);
      const refusDivergence = lancer(['scripts/provisionner_roles_db.mjs'], envSonde);
      const etatApres = (await admin.query(
        'SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1', [sondeApp])).rows[0];
      ok(refusDivergence.status !== 0 && etatApres?.rolbypassrls === true,
        'B3.2 bis un écart d attribut est REFUSÉ, et RIEN n est réécrit sans drapeau',
        `sortie ${refusDivergence.status}, bypassrls=${etatApres?.rolbypassrls}`);

      verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
      const avecDrapeau = lancer(['scripts/provisionner_roles_db.mjs'],
        { ...envSonde, TF_CORRIGER_ATTRIBUTS: 'oui' });
      await verrou.relacher();
      verrou = null;
      const etatCorrige = (await admin.query(
        'SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1', [sondeApp])).rows[0];
      ok(avecDrapeau.status === 0 && etatCorrige?.rolbypassrls === false,
        'B3.2 bis contrôle positif : avec TF_CORRIGER_ATTRIBUTS=oui la correction est appliquée',
        `sortie ${avecDrapeau.status}, bypassrls=${etatCorrige?.rolbypassrls}`);
    } finally {
      await nettoyer();
      // `DROP ROLE` échoue tant que le rôle porte des privilèges DANS la base
      // de la suite (2BP01 « privileges for schema public » / « for database »,
      // mesuré le 02/11 : deux rôles de sonde avaient fui). La base est détruite
      // dans le `finally` global ; c'est là que le rôle peut enfin disparaître.
      rolesSondes.add(sondeApp);
      rolesSondes.add(parent);
    }
  }

  // -------------------------------------------------------------------------
  // B3.3 — l'élévation temporaire a bien été révoquée.
  // -------------------------------------------------------------------------
  const migFinal = (await admin.query('SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1', [ROLE_MIGRATOR])).rows[0];
  ok(migFinal?.rolsuper === false, 'B3.3 après la chaîne, le rôle de migration n est plus superutilisateur', `superuser=${migFinal?.rolsuper}`);
} catch (erreur) {
  echecs += 1;
  console.log(`  ECHEC exécution — ${erreur.code || ''} ${String(erreur.message).slice(0, 140)}`);
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`).catch(() => {});
  // Purge des rôles de sonde : la base détruite, leurs privilèges de schéma le
  // sont aussi. Le contrôle de non-régression (`test_garde_cible_ecriture`)
  // échoue si un rôle `tf_*` survit à la suite : ce n'est pas décoratif.
  for (const r of rolesSondes) {
    await admin.query(`DROP OWNED BY ${r}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
  }
  rolesSondes.clear();

  // Restauration des verifieurs : PostgreSQL accepte un verifieur SCRAM deja
  // calcule et le stocke tel quel. C'est la seule facon de rendre au cluster
  // exactement le mot de passe qu'il avait, sans jamais le connaitre.
  let restaures = 0;
  for (const [nom, verifieur] of verifieursAvant) {
    try {
      await admin.query(`ALTER ROLE ${nom} PASSWORD ${admin.escapeLiteral(verifieur)}`);
      restaures += 1;
    } catch (erreur) {
      console.log(`  ECHEC restauration du verifieur de ${nom} — ${erreur.code || ''}`);
      echecs += 1;
    }
  }
  assertions += 1;
  if (verifieursAvant.size === 0) {
    console.log('  ok    aucun rôle préexistant à restaurer (cluster vierge)');
  } else if (restaures === verifieursAvant.size) {
    console.log(`  ok    ${restaures} vérifieur(s) de mot de passe restauré(s) — le cluster est rendu tel qu'il était`);
  } else {
    console.log(`  ECHEC ${restaures}/${verifieursAvant.size} vérifieur(s) restauré(s)`);
  }

  // Et la preuve par l'usage : la connexion applicative annoncee doit encore
  // fonctionner. Un verifieur restaure qui ne se connecte plus ne restaure rien.
  if (process.env.TF_RLS_APP_URL) {
    const { default: pgLib } = await import('pg');
    const essai = new pgLib.Client({ connectionString: process.env.TF_RLS_APP_URL, ssl: false });
    let etat = null;
    let erreur = null;
    try {
      await essai.connect();
      etat = (await essai.query('SELECT current_user AS u')).rows[0].u;
    } catch (e) {
      erreur = e.code || 'inconnu';
    } finally {
      await essai.end().catch(() => {});
    }
    assertions += 1;
    // Un nom de role est la seule preuve acceptable : un code d'erreur est une
    // chaine truthy, et l'assertion passait en vert sur `28P01`.
    if (typeof etat === 'string' && /^[a-z_][a-z0-9_]*$/.test(etat)) {
      console.log(`  ok    TF_RLS_APP_URL se connecte encore après la suite — ${etat}`);
    } else {
      console.log(`  ECHEC TF_RLS_APP_URL ne se connecte plus après la suite — ${erreur}`);
      echecs += 1;
    }
  }

  if (verrou) await verrou.relacher().catch(() => {});
  await admin.end();
}

console.log('');
if (echecs === 0) {
  console.log(`  P10.5 B2/B3 : ${assertions} assertions — chaîne dédiée, runtime non élevable.`);
  codeSortie = 0;
} else {
  console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
  codeSortie = 1;
}
process.exit(codeSortie);
