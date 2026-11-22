#!/usr/bin/env node
/**
 * P10.7 — LA SONDE C4.6 EXERCEE SUR UNE VRAIE BASE, AVEC LE VRAI ROLE.
 *
 * POURQUOI CE TEST EXISTE, ET CE QU'IL REPARE
 *
 * La sonde `probeContexteTenant` a ete livree avec trois scenarios hors ligne
 * dans `test_preuve_runtime_bout_en_bout.mjs`. Ces scenarios testent le SCRIPT
 * DE PREUVE : ils verifient qu'un corps contenant `contexteTenant` produit le
 * bon verdict. Ils ne disent RIEN du code qui PRODUIT ce corps.
 *
 * Autrement dit : si le SQL de la sonde etait faux, ou si `tracefab_app` n'avait
 * pas le droit d'appeler `tracefab_current_user_id()`, les suites vertes
 * resteraient vertes et C4.6 serait declare PASS sur une mesure qui n'a jamais
 * eu lieu. C'est exactement le faux temoin que ce chantier doit supprimer.
 *
 * Ce test execute le SQL de la sonde sur une base migree, connecte avec le role
 * applicatif REEL (`tracefab_app`, sans BYPASSRLS), et verifie :
 *
 *   1. un jeton signe pour l'organisation posee est ACCEPTE par la base ;
 *   2. un jeton signe pour une AUTRE organisation est REFUSE — c'est le
 *      controle negatif, celui qui distingue une mesure d'une presence ;
 *   3. le GUC est remis a zero et ne survit pas a la transaction.
 *
 * POURQUOI IL POSE SA PROPRE CLE, ET PAS UN OUTIL D OPERATEUR
 *
 * La premiere version de l'etape CI appelait
 * `scripts/provisionner_cle_identite.mjs`. C'est un OUTIL D OPERATEUR, classe
 * « ecrivain » par la politique du depot : `test_destructive_suite_routing`
 * interdit qu'un workflow le reference, et il a raison — un outil qui pose une
 * cle sur une base nommee n'a rien a faire dans une chaine automatique ou la
 * cible pourrait changer. Mesure du run 44631158092.
 *
 * Le test ecrit donc sa cle lui-meme, via `DATABASE_ADMIN_URL` (le
 * proprietaire des objets), sur les colonnes de `tracefab_identity_cles`.
 * C'est une fixture de test sur une base jetable, exactement comme les autres
 * fixtures du job, et elle disparait avec le runner.
 *
 * IL N'IMPORTE PAS LE MODULE TYPESCRIPT : `readiness-probes.ts` importe Prisma,
 * et le client Prisma n'est pas genere dans l'environnement d'analyse. Le test
 * rejoue donc le SQL A L'IDENTIQUE ; un garde-fou separe verifie que les deux
 * ne peuvent pas diverger silencieusement.
 *
 * SORTIE : 0 conforme · 1 defaut · 2 prerequis manquant.
 * Un test qui n'a pas tourne n'est pas un test qui passe.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

const URL_APP = process.env.TF_RLS_APP_URL;
const ROLE_APP = 'tracefab_app';

if (!URL_APP) {
  console.log('  NON EXECUTE — TF_RLS_APP_URL absent.');
  console.log('  Ce test exige le role applicatif REEL (sans BYPASSRLS).');
  process.exit(2);
}

const URL_ADMIN = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
if (!URL_ADMIN) {
  console.log('  NON EXECUTE — DATABASE_ADMIN_URL absent.');
  console.log('  Le test doit POSER sa cle sur la base jetable avant de signer.');
  process.exit(2);
}

// Cle generee pour l occasion : elle ne sort jamais de ce processus, n'est
// jamais imprimee, et meurt avec la base jetable.
const cle = randomBytes(32).toString('hex');

let echecs = 0;
let assertions = 0;
const verifier = (nom, condition, observe) => {
  assertions += 1;
  if (condition) {
    console.log(`  ok    ${nom}`);
    return;
  }
  echecs += 1;
  console.log(`  ECHEC ${nom} — observe : ${observe}`);
  // Le journal complet vit hors de l'API GitHub et l'annotation tronque :
  // `::error::` est le seul canal qui remonte a coup sur.
  console.log(`::error::sonde contexte tenant — ${nom} : ${String(observe).slice(0, 300)}`);
};

/** Signe exactement comme `signerIdentite` de api/_lib/identite-jeton.ts. */
function signer({ userId, organizationId, dureeSecondes = 60 }) {
  const expiration = Math.floor(Date.now() / 1000) + dureeSecondes;
  const corps = `v1|${userId}|${organizationId ?? ''}|tracefab_identity|${expiration}`;
  const mac = createHmac('sha256', Buffer.from(cle, 'hex')).update(corps).digest('hex');
  return { jeton: `${corps}.${mac}`, expiration };
}

/** Pose la cle de test dans la table, avec le role PROPRIETAIRE des objets. */
async function poserLaCle() {
  const admin = new pg.Client({
    connectionString: URL_ADMIN,
    ssl: /sslmode=(require|verify-full|verify-ca)/.test(URL_ADMIN) ? { rejectUnauthorized: true } : false,
  });
  await admin.connect();
  try {
    // `version` est la cle primaire ; on prend la premiere libre. La cle
    // precedente, s il y en a une, reste active : c'est la rotation, et le
    // validateur essaie TOUTES les cles actives. On ne revoque donc rien.
    await admin.query(
      `INSERT INTO public.tracefab_identity_cles (version, secret, actif)
       SELECT coalesce(max(version), 0) + 1, $1::bytea, true
         FROM public.tracefab_identity_cles`,
      [Buffer.from(cle, 'hex')],
    );
    await admin.query(
      `UPDATE public.tracefab_identity_politique SET strict = false WHERE singleton`,
    );
  } finally {
    await admin.end().catch(() => {});
  }
}

try {
  await poserLaCle();
} catch (e) {
  console.log(`  NON EXECUTE — la cle de test n a pas pu etre posee : ${e.code ?? e.message}`);
  console.log('::error::sonde contexte tenant — pose de la cle impossible : ' + String(e.message).split('\n')[0].slice(0, 200));
  process.exit(2);
}

const client = new pg.Client({
  connectionString: URL_APP,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(URL_APP) ? { rejectUnauthorized: true } : false,
});

const organisationA = randomUUID();
const organisationB = randomUUID();
const utilisateurSonde = '00000000-0000-4000-8000-000000000000';

try {
  await client.connect();
  console.log('\n  A. la connexion est bien le role applicatif');

  const qui = await client.query('SELECT current_user AS u, session_user AS s');
  verifier('current_user est le role applicatif attendu',
    qui.rows[0]?.u === ROLE_APP, `current_user=${qui.rows[0]?.u}`);
  verifier('session_user est le role applicatif attendu',
    qui.rows[0]?.s === ROLE_APP, `session_user=${qui.rows[0]?.s}`);

  const priv = await client.query(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
  );
  verifier('le role ne contourne pas la RLS',
    priv.rows[0]?.rolbypassrls === false, `bypassrls=${priv.rows[0]?.rolbypassrls}`);

  console.log('\n  B. le role peut appeler le point de passage unique');
  // Sans ce droit, la sonde echouerait en 42501 sur la base reelle — et le
  // troisieme scenario hors ligne ne le verrait jamais.
  const droit = await client.query(
    `SELECT has_function_privilege(current_user,
       'public.tracefab_current_user_id()', 'EXECUTE') AS allowed`,
  );
  verifier('EXECUTE sur tracefab_current_user_id est accorde au runtime',
    droit.rows[0]?.allowed === true, `allowed=${droit.rows[0]?.allowed}`);

  console.log('\n  C. aller-retour : le jeton signe pour A est ACCEPTE');
  const jetonA = signer({ userId: utilisateurSonde, organizationId: organisationA });

  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('tracefab.active_organization_id', $1, true)`, [organisationA]);
    await client.query(`SELECT set_config('tracefab.identity', $1, true)`, [jetonA.jeton]);
    const lu = await client.query(`SELECT public.tracefab_current_user_id()::TEXT AS lu`);
    verifier('la base rend l identite signee (aller-retour reussi)',
      String(lu.rows[0]?.lu ?? '').toLowerCase() === utilisateurSonde,
      `lu=${lu.rows[0]?.lu}`);

    console.log('\n  D. controle NEGATIF : un jeton pour B sous le contexte de A est REFUSE');
    // LE controle qui distingue une mesure d'une presence. Sans lui, une base
    // qui ignorerait le jeton rendrait le meme resultat des deux cotes.
    const jetonB = signer({ userId: utilisateurSonde, organizationId: organisationB });
    await client.query(`SELECT set_config('tracefab.identity', $1, true)`, [jetonB.jeton]);
    const refuse = await client.query(`SELECT public.tracefab_current_user_id()::TEXT AS lu`);
    verifier('le jeton d une AUTRE organisation est refuse',
      refuse.rows[0]?.lu === null, `lu=${refuse.rows[0]?.lu}`);

    console.log('\n  E. le GUC est remis a zero dans la transaction');
    await client.query(`SELECT set_config('tracefab.identity', '', true)`);
    await client.query(`SELECT set_config('tracefab.active_organization_id', '', true)`);
    const apres = await client.query(
      `SELECT nullif(current_setting('tracefab.identity', true), '') AS v`,
    );
    verifier('tracefab.identity est vide apres remise a zero',
      apres.rows[0]?.v === null, `v=${apres.rows[0]?.v}`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }

  console.log('\n  F. aucun jeton ne survit a la transaction (pool)');
  // Meme apres ROLLBACK, une connexion reutilisee ne doit rien porter. C'est la
  // propriete que le pool de Prisma exploite a chaque requete.
  const residu = await client.query(
    `SELECT nullif(current_setting('tracefab.identity', true), '') AS v,
            nullif(current_setting('tracefab.active_organization_id', true), '') AS o`,
  );
  verifier('aucun jeton residuel hors transaction',
    residu.rows[0]?.v === null, `identity=${residu.rows[0]?.v}`);
  verifier('aucune organisation residuelle hors transaction',
    residu.rows[0]?.o === null, `organisation=${residu.rows[0]?.o}`);

  console.log('\n  G. sans jeton, la base ne fabrique pas d identite');
  // En mode PERMISSIF (defaut de la migration 20261031120000), l absence de
  // jeton retombe sur le GUC `tracefab.user_id`, qui est vide ici : NULL.
  // En mode STRICT, NULL aussi — mais pour une autre raison. Le test lit donc
  // le mode et l AFFIRME, au lieu de supposer : un jour ou la politique passe
  // en strict, je veux que ce test continue de prouver la bonne propriete, pas
  // qu il passe par coIncidence.
  const pol = await client.query(
    `SELECT coalesce((SELECT p.strict FROM public.tracefab_identity_politique p
                       WHERE p.singleton), false) AS strict`,
  ).catch(() => ({ rows: [{ strict: null }] }));
  const strict = pol.rows[0]?.strict;
  console.log(`     mode strict en base : ${String(strict)}`);

  await client.query(`SELECT set_config('tracefab.user_id', '', true)`);
  const sans = await client.query(`SELECT public.tracefab_current_user_id()::TEXT AS lu`);
  verifier('sans jeton ni GUC utilisateur, l identite est NULL',
    sans.rows[0]?.lu === null, `lu=${sans.rows[0]?.lu} · strict=${String(strict)}`);

  // Controle POSITIF du mode permissif : en mode permissif, le GUC utilisateur
  // EST encore une identite (comportement historique assume par la migration).
  // Le verifier evite de lire « NULL » comme une preuve de durcissement alors
  // qu il ne fait que constater une variable vide.
  //
  // DANS UNE TRANSACTION, et c est le defaut que la CI a trouve.
  //
  // Premiere version : le set_config etait execute HORS transaction. Avec un
  // troisieme argument `true`, PostgreSQL attache la valeur a la transaction
  // courante — or il n y en a pas — donc la lecture suivante rendait NULL et
  // l assertion echouait (run 44632505714 : « lu=null »). Les suites du depot
  // qui eprouvent ce GUC (`test_neon_active_tenant`) ouvrent toutes un `begin`
  // avant de le poser : la transaction n est pas un detail de style, c est la
  // portee meme de la valeur.
  if (strict === false) {
    const u = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('tracefab.user_id', $1, true)`, [u]);
      const viaGuc = await client.query(`SELECT public.tracefab_current_user_id()::TEXT AS lu`);
      verifier('en mode permissif, le GUC utilisateur porte encore l identite (comportement documente)',
        String(viaGuc.rows[0]?.lu ?? '').toLowerCase() === u,
        `lu=${viaGuc.rows[0]?.lu}`);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  }
} catch (e) {
  echecs += 1;
  console.log(`  ECHEC — ${e.code ?? 'sans code'} : ${String(e.message).split('\n')[0]}`);
  console.log(`::error::sonde contexte tenant — ${e.code ?? 'sans code'} : ${String(e.message).split('\n')[0].slice(0, 300)}`);
} finally {
  await client.end().catch(() => {});
}

console.log(`\n  Sonde contexte tenant : ${assertions - echecs}/${assertions} assertions vertes`);
if (echecs > 0) {
  console.log(`  ECHECS (${echecs})`);
  process.exit(1);
}
process.exit(0);
