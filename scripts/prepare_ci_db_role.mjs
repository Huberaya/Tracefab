#!/usr/bin/env node
/**
 * Prépare le rôle applicatif dans la base PostgreSQL jetable AVANT les migrations.
 * Garde-fou strict : refuse tout hôte autre que localhost/127.0.0.1 et toute
 * base autre que tracefab_test. Aucun secret de production n'est accepté ici.
 *
 * CE QUI A CHANGÉ LE 30/10 — preuve d'OID, et conservation du rôle préexistant
 *
 * Le script faisait, sans rien regarder :
 *
 *     if (role absent) CREATE ROLE tracefab_app LOGIN PASSWORD <secret> ...
 *     else             ALTER ROLE tracefab_app WITH LOGIN PASSWORD <secret> ...
 *
 * Trois défauts, tous mesurables sur un cluster jetable :
 *
 *   1. `tracefab_app` est un objet de CLUSTER, pas de base. S'il préexiste et
 *      appartient à quelqu'un d'autre (rôle d'une autre instance, rôle
 *      privilégié d'exploitation), le script réécrivait son MOT DE PASSE et ses
 *      attributs, sans jamais avoir prouvé que c'était « le nôtre ». Le
 *      préflight ne dit rien de ce rôle : il ne parle que de la base.
 *   2. Aucune preuve d'OID : entre la lecture `select 1 from pg_roles` et
 *      l'`ALTER`, le rôle pouvait avoir été supprimé et recréé ; le script
 *      modifiait alors un rôle qu'il n'avait jamais inspecté.
 *   3. Aucune trace de ce qui a été créé : un rôle laissé par une exécution
 *      interrompue était indistinguable d'un rôle préexistant, et la fois
 *      suivante il était « réaffirmé » silencieusement.
 *
 * CE QUI EST DÉSORMAIS PROUVÉ
 *
 *   — le rôle visé est lu UNE fois (OID + attributs + propriété d'objets) ;
 *   — un rôle PRÉEXISTANT privilégié (SUPERUSER, BYPASSRLS, CREATEROLE,
 *     CREATEDB) ou PROPRIÉTAIRE D'OBJETS est REFUSÉ (sortie 2) sans la moindre
 *     modification : il est conservé tel quel ;
 *   — un rôle préexistant non privilégié est réaffirmé (comportement idempotent
 *     historique), et l'OID relu APRÈS est comparé à celui d'avant : si le rôle
 *     a été recréé entre-temps, le script échoue au lieu de valider ;
 *   — la création relève l'OID immédiatement et l'imprime : c'est la seule
 *     preuve qui autorise un nettoyage ultérieur ;
 *   — ce script ne contient AUCUN `DROP ROLE`. Il ne supprime jamais un rôle.
 *
 * Ce fichier ne prend PAS le verrou de cluster : il est la section critique,
 * appelée soit par un porteur déjà verrouillé (`db-deploy-throwaway.mjs`,
 * `migrer_fidelement.mjs`), soit par le lanceur commun avec `--verrou-cluster`
 * (les deux scripts shell d'intégration). Prendre le verrou ici ferait attendre
 * indéfiniment un appelant qui le détient déjà, un verrou consultatif n'étant
 * pas réentrant entre deux sessions.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const rawUrl = process.env.DATABASE_URL;
const password = process.env.TF_APP_PASSWORD;
if (!rawUrl || !password) {
  console.error('DATABASE_URL et TF_APP_PASSWORD sont requis.');
  process.exit(2);
}

// Nom du rôle : `tracefab_app` par défaut. La surcharge n'existe que pour
// éprouver les refus sur un cluster jetable ; elle est bornée aux noms `tf_*`,
// donc un test ne peut pas viser `postgres` ni un rôle d'exploitation.
const APP_ROLE = process.env.TF_APP_ROLE_NAME || 'tracefab_app';
if (APP_ROLE !== 'tracefab_app' && !/^tf_[a-z0-9_]+$/.test(APP_ROLE)) {
  console.error(`REFUS : nom de rôle ${APP_ROLE} hors liste fermée (tracefab_app ou tf_*).`);
  process.exit(2);
}

const parsed = new URL(rawUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
    || parsed.pathname !== '/tracefab_test') {
  console.error('REFUS : ce script ne fonctionne que sur la base jetable locale tracefab_test.');
  process.exit(2);
}

const client = new pg.Client({
  connectionString: rawUrl,
  ssl: sslDepuisUrl(rawUrl),
});
const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
const ident = (value) => '"' + String(value).replace(/"/g, '""') + '"';

/** Refus explicite : rien n'a été modifié. */
function refuser(message) {
  console.error(`REFUS : ${message}`);
  process.exit(2);
}

/** Le rôle 2>XX000 (`tuple concurrently updated`) est repris, comme dans lib/. */
async function executer(sql) {
  for (let tentative = 1; ; tentative += 1) {
    try {
      await client.query(sql);
      return;
    } catch (e) {
      if (e.code !== 'XX000' || tentative >= 5) throw e;
      await new Promise((r) => setTimeout(r, 20 * tentative + Math.floor(Math.random() * 30)));
    }
  }
}

async function etatRole() {
  const { rows } = await client.query(
    `SELECT r.oid, r.rolbypassrls, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
            (SELECT count(*)::int
               FROM pg_shdepend d
              WHERE d.refclassid = 'pg_authid'::regclass
                AND d.refobjid = r.oid
                AND d.deptype = 'o') AS objets_possedes
       FROM pg_roles r
      WHERE r.rolname = $1`,
    [APP_ROLE],
  );
  if (rows.length === 0) return null;
  return { ...rows[0], oid: String(rows[0].oid) };
}

await client.connect();
try {
  const avant = await etatRole();

  if (avant === null) {
    await executer(
      `CREATE ROLE ${ident(APP_ROLE)} LOGIN PASSWORD ${quote(password)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`,
    );
    console.log(`Rôle ${APP_ROLE} créé (aucun rôle de ce nom ne préexistait).`);
  } else {
    // Un rôle privilégié ou propriétaire d'objets n'est PAS le nôtre : il est
    // conservé tel quel, et le script s'arrête avant toute écriture.
    const privilegies = [];
    if (avant.rolsuper) privilegies.push('SUPERUSER');
    if (avant.rolbypassrls) privilegies.push('BYPASSRLS');
    if (avant.rolcreaterole) privilegies.push('CREATEROLE');
    if (avant.rolcreatedb) privilegies.push('CREATEDB');
    if (privilegies.length > 0) {
      refuser(`le rôle ${APP_ROLE} préexiste avec des attributs privilégiés (${privilegies.join(', ')}) `
        + '— il est CONSERVÉ, aucune modification.');
    }
    if (avant.objets_possedes > 0) {
      refuser(`le rôle ${APP_ROLE} préexiste et possède ${avant.objets_possedes} objet(s) `
        + '— il est CONSERVÉ, aucune modification.');
    }
    await executer(
      `ALTER ROLE ${ident(APP_ROLE)} WITH LOGIN PASSWORD ${quote(password)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`,
    );
    console.log(`Rôle ${APP_ROLE} préexistant (OID ${avant.oid}), attributs réaffirmés (sans BYPASSRLS).`);
  }

  // Preuve d'OID : le rôle relu doit être EXACTEMENT celui qu'on a créé ou
  // réaffirmé. Sans cela, un rôle supprimé puis recréé entre-temps serait
  // validé sur la foi d'un nom, pas d'une identité.
  const apres = await etatRole();
  if (apres === null) {
    throw new Error(`le rôle ${APP_ROLE} a disparu pendant le provisionnement.`);
  }
  if (avant !== null && apres.oid !== avant.oid) {
    throw new Error(`le rôle ${APP_ROLE} a changé d'OID pendant le provisionnement `
      + `(${avant.oid} → ${apres.oid}) : le provisionnement ne porte pas sur le rôle inspecté.`);
  }
  if (apres.rolbypassrls || apres.rolsuper || apres.rolcreaterole || apres.rolcreatedb) {
    throw new Error(`${APP_ROLE} possède un attribut privilégié inattendu.`);
  }
  if (!apres.rolcanlogin) {
    throw new Error(`${APP_ROLE} n'a pas LOGIN après provisionnement.`);
  }

  console.log(`Rôle ${APP_ROLE} préparé avant migrations : OID ${apres.oid}, `
    + `${avant === null ? 'créé par ce script' : 'préexistant réaffirmé'}, `
    + 'NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB.');
} finally {
  await client.end();
}
