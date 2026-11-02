#!/usr/bin/env node
/**
 * Provisionnement des rôles PostgreSQL de TraceFab — procédure administrative.
 *
 * CE QUE CE SCRIPT SÉPARE, ET POURQUOI
 *
 * P10.4 a mesuré trois blocages qui venaient tous du même mélange : un seul
 * compte servait de runtime, de propriétaire des objets et d'administrateur.
 *
 *   B3  `ensureAppRole` réaffirmait les attributs de `tracefab_app` par
 *       `ALTER ROLE … NOSUPERUSER`. Sur PostgreSQL 16+, changer cet attribut
 *       exige SUPERUSER (« Only roles with the SUPERUSER attribute may change
 *       the SUPERUSER attribute », mesuré). Le démarrage de la CI — et donc
 *       toute vérification — dépendait donc d'un privilège d'administration.
 *
 *   B2  la chaîne de migrations crée `tracefab_worker` et lui transfère la
 *       propriété de six fonctions. Exécutée par un rôle sans CREATEROLE, elle
 *       échoue ; exécutée par un rôle non superutilisateur sur une base où
 *       `tracefab_worker` existe déjà, elle échoue aussi sur `ALTER ROLE`.
 *
 *   B4  une appartenance accordée « pour dépanner » permet `SET ROLE` vers le
 *       propriétaire, donc la lecture des deux organisations.
 *
 * Ce script est la seule voie qui crée des rôles. Il distingue explicitement :
 *
 *   - CRÉATION     (`CREATE ROLE`) : demande CREATEROLE. Idempotent.
 *   - DURCISSEMENT (`ALTER ROLE … NOSUPERUSER`) : demande SUPERUSER lorsque
 *     l'attribut doit réellement changer. **Aucune instruction n'est émise
 *     quand le rôle est déjà conforme** — c'est ce qui permet à la CI et à
 *     l'application de démarrer sans privilège d'administration.
 *   - VÉRIFICATION (`--verifier`) : lecture seule, aucune écriture, sortie 0/1.
 *
 * CE QU'IL NE FAIT JAMAIS
 *   - il n'accorde SUPERUSER, BYPASSRLS, CREATEDB ni aucune appartenance à
 *     `tracefab_app` ;
 *   - il n'accorde à `tracefab_app` de rôle que… aucun : `tracefab_app` finit
 *     sans la moindre appartenance, ce que le script vérifie et refuse sinon ;
 *   - il n'affiche ni mot de passe, ni chaîne de connexion, ni empreinte ;
 *   - il ne crée pas `tracefab_worker` : c'est la migration 20261028120100 qui
 *     le crée. La créer ici rendrait cette migration non rejouable par un rôle
 *     non superutilisateur (branche `ALTER ROLE` — mesuré en P10.4).
 *
 * USAGE
 *   node scripts/provisionner_roles_db.mjs --verifier
 *   TF_ALLOW_PROVISIONING=oui node scripts/provisionner_roles_db.mjs
 *   TF_ALLOW_PROVISIONING=oui TF_APP_PASSWORD=… TF_MIGRATOR_PASSWORD=… \
 *     node scripts/provisionner_roles_db.mjs
 *
 * Variables de connexion (toutes optionnelles, aucune n'est affichée) :
 *   DATABASE_ADMIN_URL  compte capable de créer les rôles (prioritaire)
 *   DATABASE_URL        sinon
 *
 * Sortie : 0 conforme / provisionné · 1 écart · 2 non exécuté · 3 refus.
 */
import process from 'node:process';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import {
  ROLE_APP, ROLE_MIGRATOR, ATTRIBUTS_ATTENDUS,
  etatRole, ecartsAttributs, appartenancesDirectes, appartenancesTransitives,
} from './lib/tracefab_roles.mjs';

// `--verifier` et son alias `--dry-run` : mode SANS ECRITURE, verifie par
// scripts/test_destructive_suite_routing.mjs (politique de routage des suites
// qui ecrivent en base). Un outil d'exploitation doit pouvoir se constater
// sans agir.
const verifierSeulement = process.argv.includes('--verifier') || process.argv.includes('--dry-run');
const url = (process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL || '').trim();
if (!url) {
  console.error('  NON EXECUTE — DATABASE_ADMIN_URL (ou DATABASE_URL) est absente.');
  process.exit(2);
}
if (!verifierSeulement && process.env.TF_ALLOW_PROVISIONING !== 'oui') {
  console.error('  REFUS — le provisionnement crée des rôles. Relancer avec');
  console.error('  TF_ALLOW_PROVISIONING=oui, ou en lecture seule avec --verifier.');
  process.exit(3);
}

const db = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-provisionnement-roles' });
await db.connect();

const identite = (await db.query('SELECT current_user AS r, current_database() AS b')).rows[0];
const posture = (await db.query(
  `SELECT rolsuper, rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user`,
)).rows[0] ?? { rolsuper: false, rolcreaterole: false };

console.log('');
console.log(`  ${verifierSeulement ? 'Vérification' : 'Provisionnement'} des rôles — ${identite.b}`);
console.log(`  exécuté par : ${identite.r} (superuser=${posture.rolsuper}, createrole=${posture.rolcreaterole})`);
console.log('');

let echecs = 0;
const ok = (cond, libelle, detail = '') => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

/**
 * Crée le rôle, ou constate qu'il est conforme.
 *
 * Aucune instruction `ALTER ROLE` n'est émise quand les attributs sont déjà
 * ceux attendus : c'est la différence entre « provisionner » et « durcir ».
 * Un durcissement réellement nécessaire est signalé AVANT d'être tenté, avec
 * l'instruction exacte que l'administrateur doit jouer.
 */
async function assurerRole(nom, motDePasse) {
  const attendus = ATTRIBUTS_ATTENDUS[nom];
  const avant = await etatRole(db, nom);
  if (avant === null) {
    if (verifierSeulement) {
      ok(false, `le rôle ${nom} existe`);
      return;
    }
    const attributs = [
      attendus.rolcanlogin ? 'LOGIN' : 'NOLOGIN',
      attendus.rolsuper ? 'SUPERUSER' : 'NOSUPERUSER',
      attendus.rolbypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS',
      attendus.rolcreaterole ? 'CREATEROLE' : 'NOCREATEROLE',
      attendus.rolcreatedb ? 'CREATEDB' : 'NOCREATEDB',
      attendus.rolinherit ? 'INHERIT' : 'NOINHERIT',
    ].join(' ');
    const mdp = motDePasse ? ` PASSWORD ${quote(motDePasse)}` : '';
    try {
      await db.query(`CREATE ROLE ${nom} ${attributs}${mdp}`);
      console.log(`  créé  ${nom} (${attributs})`);
    } catch (e) {
      ok(false, `création de ${nom}`, `${e.code || ''} ${e.message.split('\n')[0].slice(0, 90)}`);
      return;
    }
  }

  const etat = await etatRole(db, nom);
  const ecarts = ecartsAttributs(nom, etat);

  if (ecarts.length > 0) {
    // Un écart d'attribut n'est PAS réparable sans le privilège correspondant.
    // On le dit, on donne l'instruction, et on ne tente rien a l'aveugle.
    const correction = `ALTER ROLE ${nom} ${Object.entries(attendus)
      .filter(([k]) => k !== 'rolinherit' && etat && etat[k] !== attendus[k])
      .map(([k, v]) => `${v ? '' : 'NO'}${k.replace(/^rol/, '').toUpperCase()}`)
      .join(' ')};`;
    if (posture.rolsuper && !verifierSeulement) {
      try {
        await db.query(correction);
        console.log(`  durci  ${nom} — un écart d'attribut a été corrigé (exécutant SUPERUSER)`);
      } catch (e) {
        ok(false, `durcissement de ${nom}`, `${e.code || ''} ${e.message.split('\n')[0].slice(0, 90)}`);
      }
    } else {
      ok(false, `attributs de ${nom} conformes`, ecarts.join(' ; '));
      console.error(`         correction requise par un administrateur : ${correction}`);
      return;
    }
  }

  const apres = await etatRole(db, nom);
  const restants = ecartsAttributs(nom, apres);
  ok(restants.length === 0, `attributs de ${nom} conformes`, restants.join(' ; ') || 'aucun écart');

  if (!verifierSeulement && motDePasse && apres) {
    // Le mot de passe n'est pas un attribut : il ne se déduit pas de l'état.
    // On ne le (re)pose que si l'appelant en fournit un.
    try {
      await db.query(`ALTER ROLE ${nom} PASSWORD ${quote(motDePasse)}`);
    } catch (e) {
      // Sur PostgreSQL 16+, changer le mot de passe d'un rôle exige ADMIN sur
      // ce rôle. Ce n'est pas bloquant : le rôle existe et ses attributs sont
      // corrects. On le signale sans faire échouer le provisioning.
      console.log(`  note  mot de passe de ${nom} non modifié (${e.code || ''}) — rôle inchangé`);
    }
  }
}

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Les droits de SCHÉMA, que les rôles ne portent pas eux-mêmes.
 *
 * Mesuré : sur PostgreSQL 15+, `public` n'accorde plus `CREATE` à `PUBLIC`.
 * Un `tracefab_migrator` fraîchement créé échoue donc dès la première
 * migration (« permission denied for schema public », 42501). Sur Neon, c'est
 * le propriétaire de la base qui porte ce droit ; la séparation des rôles
 * impose de le donner explicitement au rôle de migration, et à lui seul.
 *
 * `tracefab_app` reçoit `USAGE` (il doit résoudre les noms d'objets) et JAMAIS
 * `CREATE` : il ne crée aucun objet, tout le schéma vient des migrations.
 */
/**
 * Installe les extensions dont la chaine a besoin, ET les remet au role de
 * migration.
 *
 * Deux problemes distincts, mesures le 02/11 :
 *
 *   1. `CREATE EXTENSION` exige un privilege que le role de migration n'a pas
 *      et ne doit pas avoir (42501 « permission denied to create extension
 *      pgcrypto »). C'est donc une operation ADMINISTRATIVE, faite une fois.
 *      Sur Neon l'extension est installee par la plateforme : l'appel est un
 *      no-op, `IF NOT EXISTS` sortant avant tout controle de privilege.
 *
 *   2. QUI possede l'extension change ce que la chaine protege. Creee par le
 *      role d'administration, `pgcrypto` lui appartient ; la migration
 *      20261028120000 ne revoque l'EXECUTE que sur les fonctions possedees
 *      par le role qui execute la chaine, donc les 36 fonctions de l'extension
 *      (`hmac`, `digest`, `gen_random_uuid`…) restaient executables par
 *      `tracefab_app`, hors registre. Mesure : le registre refusait 36 noms.
 *      L'extension est donc TRANSFEREE au role de migration, ce qui la fait
 *      entrer dans le perimetre des revocations.
 */
/**
 * Installe l'extension dont la chaine a besoin, et ferme son EXECUTE a PUBLIC.
 *
 * TROIS FAITS MESURES LE 02/11, dans cet ordre.
 *
 *   1. `CREATE EXTENSION` exige un privilege que le role de migration n'a pas
 *      et ne doit pas avoir (42501 « permission denied to create extension
 *      pgcrypto »). C'est une operation ADMINISTRATIVE, faite une fois. Sur
 *      Neon l'extension est installee par la plateforme : `IF NOT EXISTS`
 *      sort avant tout controle de privilege, l'appel est un no-op.
 *
 *   2. Une extension appartient a qui l'a creee (`postgres` ici, le role de
 *      plateforme sur Neon), pas au role de migration. Il n'existe PAS de
 *      `ALTER EXTENSION ... OWNER TO` (42601). Faire dependre la securite de
 *      la propriete de l'extension etait donc une fausse piste.
 *
 *   3. Ce qui compte vraiment : les fonctions de `pgcrypto` sont livrees avec
 *      `EXECUTE` a PUBLIC. Tout role en herite — `tracefab_app` compris. Le
 *      registre runtime refusait pour cette raison 36 fonctions (`hmac`,
 *      `digest`, `gen_random_uuid`, les 18 `pgp_*`…), hors de son perimetre.
 *      On ferme donc PUBLIC sur les fonctions de l'extension. Aucune d'elles
 *      n'est appelee par le runtime : la verification HMAC vit dans une
 *      fonction SECURITY DEFINER qui appelle `hmac` sous son proprietaire.
 */
async function assurerExtensions() {
  for (const ext of ['pgcrypto']) {
    try {
      await db.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
      const { rows } = await db.query(
        `SELECT pg_catalog.pg_get_userbyid(e.extowner) AS proprietaire
           FROM pg_catalog.pg_extension e WHERE e.extname = $1`, [ext]);
      console.log(`  ok    extension ${ext} disponible (proprietaire ${rows[0]?.proprietaire}, non transferee : PostgreSQL ne le permet pas)`);
    } catch (e) {
      ok(false, `extension ${ext} disponible`, `${e.code || ''} ${e.message.split('\n')[0].slice(0, 90)}`);
      console.error(`         un administrateur doit jouer : CREATE EXTENSION IF NOT EXISTS ${ext};`);
      continue;
    }

    // Fermeture de PUBLIC sur les fonctions de l'extension.
    const membres = (await db.query(
      `SELECT p.oid::pg_catalog.regprocedure::text AS signature
         FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_proc p ON p.oid = d.objid
        WHERE d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
          AND d.refobjid = (SELECT oid FROM pg_catalog.pg_extension WHERE extname = $1)
          AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND d.deptype = 'e'`, [ext])).rows.map((r) => r.signature);

    let fermees = 0;
    for (const signature of membres) {
      try {
        await db.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`);
        fermees += 1;
      } catch (e) {
        ok(false, `EXECUTE retire a PUBLIC sur ${signature}`, `${e.code || ''}`);
      }
    }
    ok(fermees === membres.length,
      `EXECUTE de ${ext} retire a PUBLIC sur ses ${membres.length} fonction(s)`,
      `${fermees} fermee(s)`);
  }

  // Fermer PUBLIC ne suffit pas : le proprietaire des fonctions SECURITY
  // DEFINER doit pouvoir appeler `hmac`, sinon la verification du jeton echoue
  // en 42501 « permission denied for function hmac » (mesure du 02/11, apres
  // la fermeture de PUBLIC). On accorde donc le STRICT NECESSAIRE au role de
  // migration — l'appelant reel de `hmac` dans ce depot — et rien de plus :
  // `tracefab_app` reste sans aucun droit sur l'extension.
  const requises = ['public.hmac(bytea,bytea,text)'];
  for (const signature of requises) {
    try {
      await db.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${ROLE_MIGRATOR}`);
      const { rows } = await db.query(
        `SELECT pg_catalog.has_function_privilege($1, $2, 'EXECUTE') AS mig,
                pg_catalog.has_function_privilege($3, $2, 'EXECUTE') AS app`,
        [ROLE_MIGRATOR, signature, ROLE_APP]);
      ok(rows[0].mig === true && rows[0].app === false,
        `${signature} : EXECUTE accorde a ${ROLE_MIGRATOR} seul`,
        `migrator=${rows[0].mig} app=${rows[0].app}`);
    } catch (e) {
      ok(false, `${signature} : EXECUTE pour ${ROLE_MIGRATOR}`, `${e.code || ''} ${e.message.split('\n')[0].slice(0, 70)}`);
    }
  }
}

async function assurerDroitsSchema() {
  const base = (await db.query('SELECT current_database() AS b')).rows[0].b;
  const instructions = [
    `GRANT CONNECT ON DATABASE "${base}" TO ${ROLE_APP}, ${ROLE_MIGRATOR}`,
    `GRANT USAGE ON SCHEMA public TO ${ROLE_APP}`,
    // Le proprietaire du SCHEMA, et pas seulement un detenteur de CREATE :
    // la premiere migration pose `COMMENT ON SCHEMA public`, qui exige la
    // propriete du schema (« must be owner of schema public », mesure).
    // Sur Neon, c'est deja le role proprietaire des objets qui le porte.
    `ALTER SCHEMA public OWNER TO ${ROLE_MIGRATOR}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE_MIGRATOR}`,
  ];
  for (const sql of instructions) {
    try {
      await db.query(sql);
    } catch (e) {
      ok(false, 'droits de schéma', `${sql.slice(0, 42)}… → ${e.code || ''} ${e.message.split('\n')[0].slice(0, 70)}`);
    }
  }
  // Contrôle : le runtime ne doit pas pouvoir créer d'objet.
  const { rows } = await db.query(
    `SELECT has_schema_privilege($1, 'public', 'CREATE') AS app_create,
            has_schema_privilege($2, 'public', 'CREATE') AS mig_create`,
    [ROLE_APP, ROLE_MIGRATOR],
  );
  ok(rows[0].app_create === false, 'tracefab_app n a pas CREATE sur le schéma public', `create=${rows[0].app_create}`);
  ok(rows[0].mig_create === true, 'tracefab_migrator a CREATE sur le schéma public', `create=${rows[0].mig_create}`);
}

if (!verifierSeulement) {
  // L'ordre compte : `tracefab_migrator` doit exister avant la chaîne, et
  // `tracefab_app` aussi (la chaîne lui accorde des privilèges par son nom).
  await assurerRole(ROLE_APP, process.env.TF_APP_PASSWORD);
  await assurerRole(ROLE_MIGRATOR, process.env.TF_MIGRATOR_PASSWORD);
  await assurerExtensions();
  await assurerDroitsSchema();
  console.log('  note  tracefab_worker n est PAS créé ici : la migration');
  console.log('        20261028120100 le crée et lui transfère la propriété de six');
  console.log('        fonctions. Le créer avant rendrait cette migration inapplicable');
  console.log('        par un rôle non superutilisateur (mesuré, P10.4).');
} else {
  for (const nom of [ROLE_APP, ROLE_MIGRATOR]) {
    const etat = await etatRole(db, nom);
    const ecarts = ecartsAttributs(nom, etat);
    ok(ecarts.length === 0, `attributs de ${nom} conformes`, ecarts.join(' ; ') || 'aucun écart');
  }
  const worker = await etatRole(db, 'tracefab_worker');
  if (worker === null) {
    console.log('  info  tracefab_worker absent — normal avant la chaîne de migrations.');
  } else {
    const ecarts = ecartsAttributs('tracefab_worker', worker);
    ok(ecarts.length === 0, 'attributs de tracefab_worker conformes', ecarts.join(' ; ') || 'aucun écart');
  }
}

// ---------------------------------------------------------------------------
// Le contrôle qui décide de B4 : `tracefab_app` ne doit hériter de RIEN.
// On mesure la fermeture transitive, pas seulement les octrois directs :
// app -> X -> propriétaire est aussi grave que app -> propriétaire.
// ---------------------------------------------------------------------------
const directes = await appartenancesDirectes(db, ROLE_APP);
const transitives = await appartenancesTransitives(db, ROLE_APP);
const acceptables = new Set(['pg_read_all_settings', 'pg_read_all_stats', 'pg_stat_scan_tables']);
const dangereuses = directes.filter((a) => !acceptables.has(a.role_accorde));
ok(directes.length === 0, 'tracefab_app n a aucune appartenance directe',
  directes.map((a) => `${a.role_accorde}(admin=${a.admin_option},set=${a.set_option})`).join(', ') || 'aucune');
ok(dangereuses.length === 0, 'tracefab_app n hérite d aucun rôle privilégié',
  dangereuses.map((a) => a.role_accorde).join(', ') || 'aucun');
ok(transitives.length === 0, 'tracefab_app n atteint aucun rôle par transitivité',
  transitives.map((t) => `${t.atteint}(d=${t.profondeur})`).join(', ') || 'aucune');

const migDirectes = await appartenancesDirectes(db, ROLE_MIGRATOR);
ok(migDirectes.every((a) => a.role_accorde !== ROLE_APP), 'tracefab_migrator n est pas membre de tracefab_app',
  migDirectes.map((a) => a.role_accorde).join(', ') || 'aucune appartenance');

console.log('');
if (echecs === 0) {
  console.log('  VERDICT : rôles conformes — le runtime est séparé du propriétaire.');
} else {
  console.log(`  VERDICT : ${echecs} écart(s) — voir les lignes ECHEC ci-dessus.`);
}
console.log('');
await db.end();
process.exit(echecs === 0 ? 0 : 1);
