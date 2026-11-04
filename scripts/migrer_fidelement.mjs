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
// Le runner conserve un mécanisme d'élévation administrative borné à un
// registre fermé. Il ne sert à AUCUNE migration de la chaîne actuelle :
// MIGRATIONS_ASSISTEES est vide.
//
// La migration 20261028120100_worker_identity_not_forgeable est encore
// absente de Production et Préproduction. Sa version portée par cette branche
// a été corrigée avant sa première application réelle : elle crée tracefab_worker
// NOLOGIN, accorde explicitement INHERIT/SET sans ADMIN OPTION et transfère
// les six fonctions. Elle ne fait aucun ALTER ROLE ... SUPERUSER/NOSUPERUSER.
//
// Mesure directe sur Neon (branche de validation, PostgreSQL géré) :
//   - l'exécutant ne possède pas SUPERUSER, mais CREATEROLE ;
//   - CREATE ROLE produit une ligne bootstrap grantée par cloud_admin
//     (ADMIN=true, INHERIT/SET=false) ;
//   - le GRANT explicite produit une seconde ligne, grantée par l'exécutant
//     (ADMIN=false, INHERIT/SET=true) ;
//   - la migration distingue ces deux lignes et s'exécute avec succès ;
//   - tracefab_app ne devient pas membre de tracefab_worker.
//
// Cette appartenance bootstrap est gérée par Neon et ne peut pas être
// révoquée par neondb_owner. Elle ne donne aucun droit worker à tracefab_app.
// Le contrôle de migration vérifie séparément l'octroi explicite et cette
// ligne fournisseur, au lieu de sélectionner arbitrairement une ligne.
//
// Si une migration future exige réellement une élévation, elle devra être
// déclarée explicitement dans MIGRATIONS_ASSISTEES, testée séparément et
// protégée par TF_ALLOW_ELEVATION=oui et TF_ADMIN_URL. Sans les deux, le
// runner refusera l'exécution.
//
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

// Option réservée aux suites de test sur cluster local : l'administrateur
// ouvre la connexion, puis endosse le rôle migrateur réel. Cela reproduit
// l'identité effective utilisée par les déploiements sans exposer le mot de
// passe du rôle migrateur ni changer les verifieurs partagés du cluster.
const roleDemande = (process.env.TF_MIGRATION_ROLE || '').trim();
if (roleDemande) {
  if (!/^[a-z_][a-z0-9_]*$/.test(roleDemande)) {
    throw new Error('TF_MIGRATION_ROLE invalide : identifiant PostgreSQL refusé.');
  }
  const autorise = (await client.query(
    "SELECT pg_catalog.pg_has_role(session_user, $1, 'SET') AS ok", [roleDemande],
  )).rows[0]?.ok;
  if (autorise !== true) {
    throw new Error(`SET ROLE refusé pour TF_MIGRATION_ROLE=${roleDemande}.`);
  }
  await client.query(`SET ROLE "${roleDemande}"`);
  const effectif = (await client.query('SELECT current_user AS role')).rows[0].role;
  if (effectif !== roleDemande) {
    throw new Error(`SET ROLE non constaté : attendu ${roleDemande}, obtenu ${effectif}.`);
  }
  console.log(`role effectif de migration : ${effectif} (SET ROLE explicite)`);
}

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
const enEchec = registre.filter((r) => !r.finished_at && !r.rolled_back_at);

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
// Rattrapage d'une élévation laissée ouverte.
//
// Ce garde-fou générique protège les futures migrations explicitement
// inscrites dans MIGRATIONS_ASSISTEES, ainsi que les résidus d'une ancienne
// exécution interrompue. Le registre est vide pour la chaîne actuelle et la
// migration worker corrigée ne modifie plus l'attribut SUPERUSER.
//
// Si un rôle d'exécution non-bootstrap est néanmoins SUPERUSER, le runner le
// réabaisse avant de poursuivre, vérifie l'attribut et refuse de continuer
// sans connexion administrative permettant de constater la révocation.
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

// Verrou de coordination : la chaîne crée un rôle PostgreSQL partagé par le
// cluster et transfère des propriétaires de fonctions. Deux applications
// concurrentes ne doivent pas tenter ces opérations simultanément.
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
    await client.end();
    await clientAdmin.end();
    process.exit(1);
  }
  console.log(`             élévation révoquée — ${roleExecutant} n est plus superutilisateur (vérifié)`);
}

let appliquees = 0;
for (const nom of enAttente) {
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
      const { revoques } = await preparerAppartenance(client, nom, roleExecutant);
      for (const membre of revoques) {
        console.log(`             préparation — ${assisee.avant.appartenance} révoqué de ${membre} (état d'avant la migration)`);
      }
    } catch (e) {
      console.error(`  REFUS      ${nom}`);
      console.error(`             ${String(e.message).split('\n')[0]}`);
      await client.end();
      if (clientAdmin) await clientAdmin.end();
      await verrou.relacher();
      process.exit(3);
    }
  }

  // PRÉFLIGHT DE PROPRIÉTÉ (P10.6/D6), PAR MIGRATION ET NON UNE FOIS POUR TOUTES.
  //
  // `CREATE OR REPLACE FUNCTION` exige d'être le propriétaire. Un préflight
  // global, calculé avant la boucle, se trompe : la propriété CHANGE pendant la
  // chaîne — `20261028120100` transfère six fonctions à `tracefab_worker`, et
  // les migrations suivantes doivent pouvoir les remplacer. Mesuré le 02/11 :
  // un contrôle global refusait la chaîne au rang 60, alors que l'exécutant
  // devient membre de `tracefab_worker` entre-temps. Le contrôle porte donc sur
  // l'état du catalogue AU MOMENT d'exécuter la migration.
  if (!assisee) {
    const ecarts = await propriétairesInjoignables(client, roleExecutant, [{ nom, sql }]);
    if (ecarts.length > 0) {
      console.error(`  REFUS      ${nom}`);
      for (const e of ecarts) {
        console.error(`             public.${e.fonction} appartient a ${e.proprietaire},`);
        console.error(`             que ${roleExecutant} ne peut pas endosser (SET ROLE refuse).`);
      }
      console.error('             Cette operation exige le PROPRIETAIRE de ces fonctions.');
      console.error('             Relancer avec la connexion de ce proprietaire (DATABASE_URL), ou');
      console.error('             transferer la propriete par une decision explicite. Rien n a ete joue.');
      await client.end();
      if (clientAdmin) await clientAdmin.end();
      await verrou.relacher();
      process.exit(3);
    }
  }

  const executeur = client;
  try {
    await executeur.query('BEGIN');
    await executeur.query(sql);
    // Certaines migrations posent `search_path = pg_catalog` pour le reste de
    // leur transaction (20261021120000) : le registre doit donc etre qualifie,
    // et le search_path retabli, sinon l'insertion echoue apres coup.
    await executeur.query('SET LOCAL search_path TO public, pg_catalog');
    await executeur.query(
      `INSERT INTO public._prisma_migrations
         (id, checksum, migration_name, finished_at, applied_steps_count)
       VALUES ($1, $2, $3, now(), 1)`,
      [id, empreinte(fichier), nom],
    );
    await executeur.query('COMMIT');
    appliquees += 1;
    console.log(`  appliquee  ${nom}`);
    if (eleve) await revoquerElevation('migration assistée terminée');
    if (assisee && assisee.apres) {
      // Ce hook ne concerne que les migrations futures explicitement
      // inscrites avec une action "apres" dans MIGRATIONS_ASSISTEES. La chaîne
      // actuelle n'en contient aucune : la migration worker accorde elle-même
      // son membership INHERIT/SET et ne doit pas être retraitée ici.
      const sqlApres = assisee.apres.replace(/%ROLE%/g, roleExecutant);
      await (clientAdmin ?? client).query(sqlApres);
      console.log(`             rattrapage — ${sqlApres}`);
    }
  } catch (error) {
    await executeur.query('ROLLBACK').catch(() => {});
    // Comme Prisma : la ligne d'echec reste, avec finished_at NULL.
    await executeur.query(
      `INSERT INTO public._prisma_migrations (id, checksum, migration_name, logs, applied_steps_count)
       VALUES ($1, $2, $3, $4, 0)`,
      [id, empreinte(fichier), nom, String(error.message).slice(0, 4000)],
    ).catch(() => {});
    console.error(`  ECHEC      ${nom}`);
    console.error(`             ${String(error.message).split('\n')[0]}`);
    if (eleve) await revoquerElevation('échec de la migration assistée');
    await client.end();
    if (clientAdmin) await clientAdmin.end();
    await verrou.relacher();
    process.exit(1);
  }
}

console.log(`\n${appliquees} migration(s) appliquee(s).`);
await client.end();
if (clientAdmin) await clientAdmin.end();
await verrou.relacher();
