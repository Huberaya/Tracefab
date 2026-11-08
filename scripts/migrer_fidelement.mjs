#!/usr/bin/env node
/**
 * Reimplementation fidèle de `prisma migrate deploy`, pour usage HORS LIGNE.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * Dans cet environnement, `prisma migrate deploy` est inutilisable, pour deux
 * raisons independantes et verifiees :
 *
 *   1. le schema-engine classique n'existe pas et son telechargement
 *      (`binaries.prisma.sh`) est bloque ;
 *   2. le moteur de schema en JavaScript (Prisma 6.19, `engine: 'js'`), qui
 *      fonctionne sans binaire, echoue a l'initialisation du registre :
 *      « Column type 'name' could not be deserialized from the database » —
 *      reproduit sur PostgreSQL 18.4 reel, pas seulement sur PGlite.
 *
 * CE QUE CE SCRIPT EST, ET CE QU'IL N'EST PAS
 *
 * Il applique les migrations en attente, dans l'ordre lexicographique du nom de
 * dossier (l'ordre qu'utilise Prisma), en une transaction par migration, et
 * consigne chaque migration terminee dans `_prisma_migrations` avec l'empreinte
 * sha256 du fichier `migration.sql`.
 *
 * Il N'EST PAS une preuve que `prisma migrate deploy` se comporte pareil. La
 * valeur d'empreinte produite par le moteur Rust de Prisma n'a pas pu etre
 * comparee ici : aucun registre ecrit par le vrai CLI n'est disponible hors
 * ligne. En consequence :
 *
 *   - ce script sert a EPROUVER une chaine de migrations sur une base de TEST ;
 *   - il ne doit JAMAIS servir a migrer une base qui recevra ensuite le vrai
 *     CLI, sous peine de faire echouer la comparaison d'empreintes.
 *
 * La production doit passer par `prisma migrate deploy`, jamais par ceci.
 *
 * GARDE-FOUS
 *
 * - Refus de tout hote ressemblant a la production (`TF_HOTE_PRODUCTION`).
 * - `TF_ALLOW_WRITE=oui` obligatoire : aucune ecriture accidentelle.
 * - Mode `--etat` (ou `--dry-run`) en lecture seule, qui n'ecrit rien du tout.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { verrouillerCluster } from './lib/ephemeral-db.mjs';
import { MIGRATIONS_ASSISTEES, preparerAppartenance } from './lib/migrations_assistees.mjs';
import { propriétairesInjoignables } from './lib/preflight_proprietaires.mjs';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const RACINE = process.cwd();
const DOSSIER = process.env.TF_MIGRATIONS_PATH
  ? path.resolve(RACINE, process.env.TF_MIGRATIONS_PATH)
  : path.join(RACINE, 'prisma/migrations');

const HOTE_PRODUCTION = process.env.TF_HOTE_PRODUCTION
  || 'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech';

// `--etat` et `--dry-run` sont la meme chose : lire le registre et la liste des
// migrations en attente, sans rien ecrire. Le second nom existe pour que la
// politique de routage des suites destructives reconnaisse le mode sans
// ecriture sans avoir a connaitre ce vocabulaire.
const lireEtatSeulement = process.argv.includes('--etat') || process.argv.includes('--dry-run');
// `--jusqu-a <dossier>` : s'arreter a une migration precise incluse. Utile pour
// reconstituer un etat anterieur (ex. une base a 58 migrations avant d'appliquer
// la 59e) sans reecrire l'historique : la base est neuve, le registre refletera
// exactement ce qui a ete joue.
const argJusque = process.argv.indexOf('--jusqu-a');
const migrationDerniere = argJusque > -1 ? process.argv[argJusque + 1] : null;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('NON EXECUTE — DATABASE_URL est obligatoire.');
  process.exit(2);
}

let hote = '';
try { hote = new URL(url).hostname; } catch { /* laisse vide */ }
if (!hote) {
  console.error('REFUS — DATABASE_URL illisible.');
  process.exit(2);
}
if (hote === HOTE_PRODUCTION || /^ep-polished-night/.test(hote)) {
  console.error(`REFUS — la cible (${hote}) est la base de PRODUCTION.`);
  console.error('Ce script ne migre que des bases de test. Sortie 3.');
  process.exit(3);
}
if (!lireEtatSeulement && process.env.TF_ALLOW_WRITE !== 'oui') {
  console.error('REFUS — ecriture non autorisee. Relancer avec TF_ALLOW_WRITE=oui,');
  console.error('ou en lecture seule avec --etat. Sortie 3.');
  process.exit(3);
}

const migrationsDisque = readdirSync(DOSSIER)
  .filter((nom) => /^\d/.test(nom) && statSync(path.join(DOSSIER, nom)).isDirectory())
  .filter((nom) => existsSync(path.join(DOSSIER, nom, 'migration.sql')))
  .sort();

const empreinte = (fichier) => createHash('sha256').update(readFileSync(fichier)).digest('hex');

// ---------------------------------------------------------------------------
// Assistance administrative, bornee a une liste fermee.
//
// POURQUOI ELLE EXISTE
//
// La migration 20261028120100 cree `tracefab_worker` puis lui transfere la
// propriete de six fonctions. Sur PostgreSQL 16+, deux impasses mesurees le
// 30/10/2026 sur un cluster jetable (PG 17.10) :
//
//   - role ABSENT : la migration le cree, mais un executant CREATEROLE ne
//     recoit que l'option ADMIN (set_option = false, mesure). Le `GRANT` de la
//     migration est saute parce que `pg_has_role(...,'MEMBER')` rend deja vrai,
//     et le `ALTER FUNCTION ... OWNER TO tracefab_worker` echoue en
//     « must be able to SET ROLE "tracefab_worker" » ;
//   - role PRESENT : la branche ELSE joue `ALTER ROLE ... NOSUPERUSER`, et
//     PostgreSQL 16+ exige SUPERUSER pour changer cet attribut
//     (« Only roles with the SUPERUSER attribute may change the SUPERUSER
//     attribute »).
//
// Aucune des deux branches n'est donc jouable par un role non superutilisateur
// sur PostgreSQL 16+. La migration ne peut pas etre reecrite : elle est deja
// appliquee en production, et changer son fichier changerait son empreinte.
//
// Deux autres voies ont ete essayees et mesurées, toutes deux fermees :
//   - executer la migration par un role administratif distinct : le controle de
//     propriete de la migration exige `current_user` = proprietaire des
//     fonctions, donc l'executant doit etre le proprietaire des objets ;
//   - `SET ROLE` vers le proprietaire depuis un compte superutilisateur : les
//     controles d'`ALTER ROLE` portent sur `current_user`, qui redevient non
//     superutilisateur — mesure : trois « permission denied to alter role ».
//
// CE QUI EST FAIT ICI, ET CE QUI N'EST PAS FAIT
//
// L'elevation est TEMPORAIRE, BORNEE A UNE MIGRATION, TRACEE ET REVOQUEE :
// le role proprietaire recoit SUPERUSER juste avant cette migration, et le
// perd juste apres, y compris en cas d'echec. Le role de migration n'est
// jamais superutilisateur en dehors de cette fenetre, et le script refuse de
// continuer si la revocation n'est pas constatee.
//
// Ce n'est pas la solution preferee : c'est la seule qui reste quand on refuse
// de reecrire une migration deja appliquee. Elle exige un opt-in explicite
// (`TF_ALLOW_ELEVATION=oui`) et une connexion administrative (`TF_ADMIN_URL`).
// Sans les deux, le script REFUSE la migration au lieu de la contourner.
// ---------------------------------------------------------------------------
const urlAdmin = (process.env.TF_ADMIN_URL || '').trim();
const elevationAutorisee = process.env.TF_ALLOW_ELEVATION === 'oui';
let clientAdmin = null;
if (urlAdmin) {
  clientAdmin = new pg.Client({
    connectionString: urlAdmin,
    ssl: sslDepuisUrl(urlAdmin),
    application_name: 'tracefab-migration-administrative',
  });
  await clientAdmin.connect();
}

const client = new pg.Client({
  connectionString: url,
  ssl: sslDepuisUrl(url),
  application_name: 'tracefab-migration-fidele',
});
await client.connect();

// Le registre est cree a l'identique de ce que pose Prisma.
await client.query(`
  CREATE TABLE IF NOT EXISTS _prisma_migrations (
    id VARCHAR(36) PRIMARY KEY NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0
  )
`);

const roleExecutant = (await client.query('SELECT current_user AS u')).rows[0].u;
const { rows: registre } = await client.query(
  'SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations',
);
const terminees = new Set(
  registre.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name),
);
const enEchec = registre.filter((r) => !r.finished_at);

console.log(`cible ${hote} · ${migrationsDisque.length} migration(s) sur disque · ${terminees.size} deja appliquee(s)`);
if (enEchec.length) {
  console.log(`EN ECHEC dans le registre : ${enEchec.map((r) => r.migration_name).join(', ')}`);
}

if (migrationDerniere) {
  if (!migrationsDisque.includes(migrationDerniere)) {
    console.error(`REFUS — migration inconnue : ${migrationDerniere}`);
    await client.end();
    process.exit(2);
  }
  const rang = migrationsDisque.indexOf(migrationDerniere);
  console.log(`borne : arret apres ${migrationDerniere} (rang ${rang + 1}/${migrationsDisque.length}).`);
  migrationsDisque.length = rang + 1;
}

const enAttente = migrationsDisque.filter((nom) => !terminees.has(nom));
if (!enAttente.length) {
  console.log('Aucune migration en attente.');
} else {
  console.log(`en attente (${enAttente.length}), dans cet ordre :`);
  enAttente.forEach((nom, i) => console.log(`  ${i + 1}. ${nom}`));
}

if (lireEtatSeulement) {
  console.log('\nmode lecture seule : aucune ecriture effectuee.');
  await client.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Rattrapage d'une elevation laissee ouverte.
//
// L'elevation de 20261028120100 est temporaire ET reverifiee apres coup. Il
// reste un cas : un processus tue entre `ALTER ROLE ... SUPERUSER` et la
// revocation (SIGKILL, coupure, OOM). La fenetre est alors ouverte
// indefiniment, et rien ne la refermerait — c'est exactement ce que la mission
// interdit de laisser derriere soi.
//
// On refuse donc de continuer tant que le role executant est superutilisateur :
// on le reabaisse d'abord, on le VERIFIE, puis on poursuit. Sans connexion
// d'administration, on s'arrete : constater sans pouvoir corriger n'autorise
// pas a continuer.
// ---------------------------------------------------------------------------
// Un executant DEJA superutilisateur (le compte d'administration du cluster,
// `postgres`) n'a rien a elever : la migration assistee passe telle quelle. En
// revanche on ne lui retire jamais son attribut — sur `postgres`, `ALTER ROLE
// ... NOSUPERUSER` echoue en 0A000 (« The bootstrap superuser must have the
// SUPERUSER attribute », mesure du 02/11). Cette topologie est celle des suites
// de CI ; elle n'est pas la cible (voir docs/security/2026-10-31-p105-provisionnement.md).
let dejaSuperuser = false;
{
  const { rows } = await client.query(
    'SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1', [roleExecutant]);
  if (rows[0]?.rolsuper === true && roleExecutant === 'postgres') {
    dejaSuperuser = true;
    console.log(`NOTE       ${roleExecutant} est le compte d'administration du cluster : la chaîne`);
    console.log('           s exécute avec SUPERUSER, sans élévation ni révocation. Ce n est PAS');
    console.log('           la topologie cible — un exécutant non superutilisateur est exigé.');
  } else if (rows[0]?.rolsuper === true) {
    console.log(`ATTENTION  ${roleExecutant} est SUPERUSER avant la chaine — elevation résiduelle d'une exécution interrompue.`);
    if (!clientAdmin) {
      console.error(`REFUS — ${roleExecutant} doit être réabaissé, et TF_ADMIN_URL est absente.`);
      console.error('        Un rôle resté superutilisateur ne se corrige pas depuis lui-même.');
      await client.end();
      process.exit(3);
    }
    await clientAdmin.query(`ALTER ROLE ${roleExecutant} NOSUPERUSER`);
    const controle = (await clientAdmin.query(
      'SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1', [roleExecutant])).rows[0];
    if (controle?.rolsuper !== false) {
      console.error(`  ECHEC      rattrapage NON constaté — ${roleExecutant} est encore superutilisateur. Arrêt.`);
      await client.end();
      await clientAdmin.end();
      process.exit(1);
    }
    console.log(`           ${roleExecutant} réabaissé (NOSUPERUSER) et vérifié avant de poursuivre.`);
  }
}

// Verrou de CLUSTER : la chaine contient un `ALTER ROLE` (20261028120100). Deux
// applications concurrentes sur le meme serveur se heurtent en `XX000`.
const verrou = await verrouillerCluster({ urlProprietaire: url });

/**
 * Révoque l'élévation et VÉRIFIE qu'elle est bien révoquée.
 * Ne jamais laisser un rôle superutilisateur derrière soi : si la révocation
 * échoue, le script s'arrête en erreur plutôt que de continuer.
 */
async function revoquerElevation(moment) {
  await clientAdmin.query(`ALTER ROLE ${roleExecutant} NOSUPERUSER`);
  const { rows } = await clientAdmin.query(
    'SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1', [roleExecutant],
  );
  if (!rows[0] || rows[0].rolsuper !== false) {
    console.error(`  ECHEC      révocation de l'élévation de ${roleExecutant} NON constatée après ${moment}.`);
    console.error('             Arrêt : laisser un rôle superutilisateur serait pire que l échec.');
    await revoquerAppartenanceWorker('échec de révocation SUPERUSER').catch((x) => console.error(x.message));
    await client.end();
    await clientAdmin.end();
    process.exit(1);
  }
  console.log(`             élévation révoquée — ${roleExecutant} n est plus superutilisateur (vérifié)`);
}

const MIGRATION_WORKER_TERMINALE = '20261108120700_assert_worker_membership_revoked';
const MIGRATIONS_AVEC_WORKER_TEMPORAIRE = new Set([
  // Ces deux migrations vérifient elles-mêmes pg_has_role(..., 'SET') :
  // la première transfère des fonctions au worker, la seconde vérifie les
  // prérequis d'appartenance. Le préflight de propriété ne peut pas détecter
  // les ALTER OWNER construits dynamiquement dans un bloc DO.
  '20261108120100_worker_fonctions_systeme_completes',
  '20261108120200_corrections_p106_ownership_et_appartenance',
]);
const identifiantSql = (v) => '"' + String(v).replace(/"/g, '""') + '"';
const gestionRoles = dejaSuperuser ? client : clientAdmin;

// Une exécution lancée par postgres doit aussi réparer un SUPERUSER résiduel
// laissé sur le compte migrateur par un ancien processus interrompu.
if (roleExecutant !== 'tracefab_migrator') {
  const etatMigrator = (await client.query(
    "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_migrator'",
  )).rows[0];
  if (etatMigrator?.rolsuper === true) {
    if (!gestionRoles) throw new Error('tracefab_migrator est SUPERUSER, mais aucune connexion administrative ne peut le réabaisser');
    await gestionRoles.query('ALTER ROLE tracefab_migrator NOSUPERUSER');
    const verifMigrator = (await gestionRoles.query(
      "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_migrator'",
    )).rows[0];
    if (verifMigrator?.rolsuper !== false) throw new Error('révocation SUPERUSER de tracefab_migrator non vérifiée');
    console.log('             tracefab_migrator réabaissé NOSUPERUSER et vérifié (récupération)');
  }
}

/** Révoque l'appartenance worker et vérifie l'absence effective. */
async function revoquerAppartenanceWorker(moment) {
  // Toujours nettoyer le rôle courant ET le migrateur nominal : un run précédent
  // peut avoir été lancé avec une autre identité administrative.
  const cibles = [...new Set([roleExecutant, 'tracefab_migrator'])];
  for (const cible of cibles) {
    const etat = (await client.query(
      `SELECT r.rolsuper,
              pg_catalog.pg_has_role(r.oid, w.oid, 'MEMBER') AS membre
         FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_roles w
        WHERE r.rolname = $1 AND w.rolname = 'tracefab_worker'`,
      [cible],
    )).rows[0];
    // Un SUPERUSER peut endosser tous les rôles implicitement : ce n'est pas
    // une appartenance pg_auth_members à révoquer. Le migrator, lui, est
    // réabaissé avant ce contrôle et doit avoir une appartenance effective false.
    if (!etat || etat.rolsuper === true || !etat.membre) continue;
    if (!gestionRoles) {
      throw new Error(`appartenance tracefab_worker résiduelle pour ${cible}, sans connexion autorisée pour la révoquer (${moment})`);
    }
    await gestionRoles.query(`REVOKE tracefab_worker FROM ${identifiantSql(cible)}`);
    const verif = (await gestionRoles.query(
      `SELECT pg_catalog.pg_has_role(r.oid, w.oid, 'MEMBER') AS membre
         FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_roles w
        WHERE r.rolname = $1 AND w.rolname = 'tracefab_worker'`,
      [cible],
    )).rows[0];
    if (verif?.membre !== false) {
      throw new Error(`révocation tracefab_worker NON constatée pour ${cible} (${moment})`);
    }
    console.log(`             appartenance worker temporaire révoquée et vérifiée — ${cible} (${moment})`);
  }
}

// Nettoyage systématique au démarrage : toute appartenance résiduelle d'un
// ancien runner est révoquée AVANT le premier préflight. Une appartenance
// créée par la version corrigée ne survit jamais à une transaction ; ce
// rattrapage couvre les versions antérieures et les arrêts brutaux historiques.
try {
  await revoquerAppartenanceWorker('récupération au démarrage');
} catch (e) {
  console.error(`REFUS — nettoyage initial de l'appartenance worker impossible : ${e.message}`);
  await client.end().catch(() => {});
  if (clientAdmin) await clientAdmin.end().catch(() => {});
  await verrou.relacher().catch(() => {});
  process.exit(3);
}

let nettoyageSignalEnCours = false;
let transactionWorkerTemporaireEnCours = false;
async function terminerSurSignal(signal, code) {
  if (nettoyageSignalEnCours) return;
  nettoyageSignalEnCours = true;
  console.error(`\\n${signal} reçu — révocation de l'appartenance worker temporaire.`);
  if (transactionWorkerTemporaireEnCours && clientAdmin) {
    await clientAdmin.query('ROLLBACK').catch(() => {});
    transactionWorkerTemporaireEnCours = false;
  } else {
    try { await revoquerAppartenanceWorker(`signal ${signal}`); }
    catch (e) { console.error(`ECHEC nettoyage signal : ${e.message}`); }
  }
  await client.end().catch(() => {});
  if (clientAdmin) await clientAdmin.end().catch(() => {});
  await verrou.relacher().catch(() => {});
  process.exit(code);
}
process.once('SIGINT', () => { void terminerSurSignal('SIGINT', 130); });
process.once('SIGTERM', () => { void terminerSurSignal('SIGTERM', 143); });

let appliquees = 0;
for (const nom of enAttente) {
  if (nom === MIGRATION_WORKER_TERMINALE) {
    // La garde terminale n'est exécutée qu'après révocation effective.
    await revoquerAppartenanceWorker('avant migration terminale');
  }
  const fichier = path.join(DOSSIER, nom, 'migration.sql');
  const sql = readFileSync(fichier, 'utf8');
  const id = crypto.randomUUID();
  const assisee = MIGRATIONS_ASSISTEES[nom];
  if (assisee && !dejaSuperuser && (!clientAdmin || !elevationAutorisee)) {
    console.error(`  REFUS      ${nom}`);
    console.error(`             ${assisee.raison}`);
    console.error('             Procédure : docs/security/2026-10-31-p105-provisionnement.md § 4.');
    console.error('             Il faut TF_ADMIN_URL ET TF_ALLOW_ELEVATION=oui. Rien n a ete joue.');
    await client.end();
    if (clientAdmin) await clientAdmin.end();
    await verrou.relacher();
    process.exit(3);
  }

  // Élévation bornée : uniquement autour de cette migration, révoquée ensuite.
  let eleve = false;
  if (assisee && !dejaSuperuser) {
    await clientAdmin.query(`ALTER ROLE ${roleExecutant} SUPERUSER`);
    eleve = true;
    console.log(`             assistée — élévation temporaire de ${roleExecutant} (SUPERUSER), révoquée après`);
  }

  // PRÉPARATION (P10.6) : ramener l'état d'appartenance à celui d'avant la
  // migration. Sans cela, PostgreSQL refuse le `REVOKE` de son § 6 bis en
  // 2BP01 et la migration devient non rejouable dans un cluster déjà utilisé
  // (mesuré le 02/11). La logique est dans `lib/migrations_assistees.mjs`, pour
  // être partagée avec les autres outils qui appliquent la chaîne.
  if (assisee) {
    try {
      const { revoques } = await preparerAppartenance(gestionRoles, nom, roleExecutant);
      for (const membre of revoques) {
        console.log(`             préparation — ${assisee.avant.appartenance} révoqué de ${membre} (état d'avant la migration)`);
      }
    } catch (e) {
      console.error(`  REFUS      ${nom}`);
      console.error(`             ${String(e.message).split('\n')[0]}`);
      await revoquerAppartenanceWorker('échec de préparation').catch((x) => console.error(x.message));
      await client.end();
      if (clientAdmin) await clientAdmin.end();
      await verrou.relacher();
      process.exit(3);
    }
  }

  // PRÉFLIGHT DE PROPRIÉTÉ (P10.6/D6), au moment exact de la migration.
  // Si les seuls propriétaires injoignables sont tracefab_worker, l'accès est
  // ouvert dans la transaction de cette migration puis révoqué AVANT COMMIT.
  let workerTemporaire = !dejaSuperuser && MIGRATIONS_AVEC_WORKER_TEMPORAIRE.has(nom);
  if (!assisee) {
    const ecarts = await propriétairesInjoignables(client, roleExecutant, [{ nom, sql }]);
    if (ecarts.length > 0) {
      const autres = ecarts.filter((e) => e.proprietaire !== 'tracefab_worker');
      if (autres.length > 0 || !clientAdmin || roleExecutant !== 'tracefab_migrator') {
        console.error(`  REFUS      ${nom}`);
        for (const e of ecarts) {
          console.error(`             public.${e.fonction} appartient a ${e.proprietaire},`);
          console.error(`             que ${roleExecutant} ne peut pas endosser (SET ROLE refuse).`);
        }
        console.error('             Seul tracefab_worker peut recevoir une appartenance temporaire, dans une transaction.');
        await revoquerAppartenanceWorker('échec de préflight').catch((x) => console.error(x.message));
        await client.end();
        if (clientAdmin) await clientAdmin.end();
        await verrou.relacher();
        process.exit(3);
      }
      workerTemporaire = true;
    }
  }

  if (workerTemporaire && (!clientAdmin || roleExecutant !== 'tracefab_migrator')) {
    console.error(`REFUS — ${nom} exige TF_ADMIN_URL et une session tracefab_migrator pour accorder le worker dans une transaction.`);
    await client.end().catch(() => {});
    if (clientAdmin) await clientAdmin.end().catch(() => {});
    await verrou.relacher().catch(() => {});
    process.exit(3);
  }

  const executeur = workerTemporaire ? clientAdmin : client;
  let commitEffectue = false;
  try {
    await executeur.query('BEGIN');
    if (workerTemporaire) {
      transactionWorkerTemporaireEnCours = true;
      await executeur.query('GRANT tracefab_worker TO tracefab_migrator WITH INHERIT TRUE, SET TRUE, ADMIN FALSE');
      const options = (await executeur.query(
        `SELECT pg_catalog.pg_has_role($1, 'tracefab_worker', 'SET') AS peut_set,
                (SELECT bool_and(m.inherit_option) FROM pg_catalog.pg_auth_members m
                  JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
                  JOIN pg_catalog.pg_roles u ON u.oid = m.member
                 WHERE r.rolname = 'tracefab_worker' AND u.rolname = $1) AS inherit_option,
                (SELECT bool_and(m.set_option) FROM pg_catalog.pg_auth_members m
                  JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
                  JOIN pg_catalog.pg_roles u ON u.oid = m.member
                 WHERE r.rolname = 'tracefab_worker' AND u.rolname = $1) AS set_option,
                (SELECT COALESCE(bool_or(m.admin_option), false) FROM pg_catalog.pg_auth_members m
                  JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
                  JOIN pg_catalog.pg_roles u ON u.oid = m.member
                 WHERE r.rolname = 'tracefab_worker' AND u.rolname = $1) AS admin_option`,
        [roleExecutant],
      )).rows[0];
      if (options?.peut_set !== true || options?.inherit_option !== true
          || options?.set_option !== true || options?.admin_option !== false) {
        throw new Error(`appartenance worker temporaire non conforme : SET=${options?.peut_set}, INHERIT=${options?.inherit_option}, SET_OPTION=${options?.set_option}, ADMIN=${options?.admin_option}`);
      }
      await executeur.query(`SET LOCAL ROLE ${identifiantSql(roleExecutant)}`);
      const ecartsRestants = await propriétairesInjoignables(executeur, roleExecutant, [{ nom, sql }]);
      if (ecartsRestants.length > 0) throw new Error(`préflight worker toujours bloquant : ${ecartsRestants.map((e) => e.fonction).join(', ')}`);
    }
    await executeur.query(sql);
    await executeur.query('SET LOCAL search_path TO public, pg_catalog');
    await executeur.query(
      `INSERT INTO public._prisma_migrations
         (id, checksum, migration_name, finished_at, applied_steps_count)
       VALUES ($1, $2, $3, now(), 1)`,
      [id, empreinte(fichier), nom],
    );
    if (workerTemporaire) {
      await executeur.query('RESET ROLE');
      await executeur.query('REVOKE tracefab_worker FROM tracefab_migrator');
      const membre = (await executeur.query(
        `SELECT pg_catalog.pg_has_role('tracefab_migrator', 'tracefab_worker', 'MEMBER') AS membre`,
      )).rows[0]?.membre;
      if (membre !== false) throw new Error('révocation worker non constatée avant COMMIT');
    }
    await executeur.query('COMMIT');
    transactionWorkerTemporaireEnCours = false;
    commitEffectue = true;
    appliquees += 1;
    console.log(`  appliquee  ${nom}`);
    if (eleve) await revoquerElevation('migration assistée terminée');

  } catch (error) {
    if (!commitEffectue) {
      await executeur.query('ROLLBACK').catch(() => {});
      transactionWorkerTemporaireEnCours = false;
      const journaliseur = workerTemporaire ? client : executeur;
      await journaliseur.query(
        `INSERT INTO public._prisma_migrations (id, checksum, migration_name, logs, applied_steps_count)
         VALUES ($1, $2, $3, $4, 0)`,
        [id, empreinte(fichier), nom, String(error.message).slice(0, 4000)],
      ).catch(() => {});
    } else {
      console.error(`  ATTENTION migration ${nom} déjà COMMITée ; rattrapage post-migration non terminé.`);
      console.error('             La reprise doit rétablir l appartenance temporaire avant les migrations suivantes.');
    }
    console.error(`  ECHEC      ${nom}`);
    console.error(`             ${String(error.message).split('\n')[0]}`);
    if (eleve && !commitEffectue) await revoquerElevation('échec de la migration assistée');
    await revoquerAppartenanceWorker('échec de migration').catch((x) => console.error(`ECHEC révocation worker : ${x.message}`));
    await client.end();
    if (clientAdmin) await clientAdmin.end();
    await verrou.relacher();
    process.exit(1);
  }
}

await revoquerAppartenanceWorker('fin de chaîne');
console.log(`\n${appliquees} migration(s) appliquee(s).`);
await client.end();
if (clientAdmin) await clientAdmin.end();
await verrou.relacher();
