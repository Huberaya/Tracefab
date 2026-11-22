/**
 * Identite d'execution des suites base de donnees (R11 / R13, 30/10).
 *
 * POURQUOI CE MODULE
 *
 * Deux constats mesures pendant l'inventaire CI :
 *
 *   — le job « Base » se connecte avec `postgres`, SUPERUTILISATEUR, donc
 *     `BYPASSRLS` : une suite qui mesure la RLS sans basculer de role mesure un
 *     contournement, et verdit a tort ;
 *   — `test_neon_publication_deploiement` retombait SILENCIEUSEMENT sur l'URL
 *     proprietaire quand `TF_RLS_APP_URL` manquait : l'epreuve de route
 *     s'executait alors avec l'identite d'administration, sans le dire.
 *
 * Une identite fausse ne doit jamais produire un rouge apres les assertions
 * metier : elle doit produire un ARRET AVANT, explicite. C'est ce que font
 * `assertRoleApplicatif` et `assertMemeCluster`.
 */
import pg from 'pg';
import { sslDepuisUrl } from './pg-ssl.mjs';
import { identiteServeur } from './ephemeral-db.mjs';

/** Attributs qu'un role applicatif ne doit JAMAIS porter. */
const ATTRIBUTS_INTERDITS = [
  ['rolsuper', 'SUPERUSER'],
  ['rolbypassrls', 'BYPASSRLS'],
  ['rolcreaterole', 'CREATEROLE'],
  ['rolcreatedb', 'CREATEDB'],
];

/**
 * Verifie que la session courante est bien celle du role applicatif attendu.
 *
 * @param {import('pg').Client} client session ouverte
 * @param {{attendu?: string, etiquette?: string}} [options]
 * @returns {Promise<{rolname: string, oid: string}>}
 * @throws si le role est privilegie, s'il ne peut pas se connecter, ou si son
 *         nom ne correspond pas a celui attendu
 */
export async function assertRoleApplicatif(client, { attendu = 'tracefab_app', etiquette = 'role applicatif' } = {}) {
  const { rows } = await client.query(`
    SELECT r.rolname, r.oid::text AS oid, r.rolsuper, r.rolbypassrls,
           r.rolcreaterole, r.rolcreatedb, r.rolcanlogin
      FROM pg_roles r
     WHERE r.rolname = current_user`);
  if (rows.length === 0) {
    throw new Error(`${etiquette} : session sans role identifiable — arret avant les assertions metier`);
  }
  const r = rows[0];
  if (attendu && r.rolname !== attendu) {
    throw new Error(
      `${etiquette} : connecte avec « ${r.rolname} », « ${attendu} » attendu `
      + '— arret avant les assertions metier (une identite fausse ne mesure pas la RLS)',
    );
  }
  const interdits = ATTRIBUTS_INTERDITS.filter(([colonne]) => r[colonne] === true).map(([, nom]) => nom);
  if (interdits.length > 0) {
    throw new Error(
      `${etiquette} : le role « ${r.rolname} » porte ${interdits.join(', ')} `
      + '— arret avant les assertions metier (les politiques RLS ne seraient pas evaluees)',
    );
  }
  if (r.rolcanlogin !== true) {
    throw new Error(`${etiquette} : le role « ${r.rolname} » n est pas connectable — incoherence`);
  }
  return { rolname: r.rolname, oid: r.oid };
}

/**
 * Verifie que deux connexions visent le MEME cluster (`system_identifier`).
 *
 * Sans cette preuve, une suite qui melange `DATABASE_URL` et `TF_RLS_APP_URL`
 * peut comparer deux serveurs differents et conclure n'importe quoi.
 *
 * @param {import('pg').Client} a
 * @param {import('pg').Client} b
 * @param {{attendu?: string}} [options]
 * @returns {Promise<{systemIdentifier: string}>}
 */
export async function assertMemeCluster(a, b, { attendu } = {}) {
  const [ia, ib] = await Promise.all([identiteServeur(a), identiteServeur(b)]);
  if (ia.systemIdentifier !== ib.systemIdentifier) {
    throw new Error(
      `les deux connexions ne visent pas le meme cluster `
      + `(${ia.systemIdentifier} vs ${ib.systemIdentifier}) — arret avant les assertions metier`,
    );
  }
  if (attendu && ia.systemIdentifier !== String(attendu)) {
    throw new Error(
      `cluster ${ia.systemIdentifier} different de celui attendu (${attendu}) — arret`,
    );
  }
  return { systemIdentifier: ia.systemIdentifier };
}

/**
 * Ouvre une connexion applicative EXIGEE (jamais de repli sur le proprietaire).
 *
 * @param {string|undefined} url valeur de `TF_RLS_APP_URL`
 * @param {{variable?: string, attendu?: string}} [options]
 */
export async function ouvrirRoleApplicatif(url, { variable = 'TF_RLS_APP_URL', attendu = 'tracefab_app' } = {}) {
  if (!url || !String(url).trim()) {
    throw new Error(
      `${variable} obligatoire : cette epreuve mesure la RLS sous le role applicatif. `
      + 'Aucun repli sur l URL proprietaire n est permis — arret avant les assertions metier (sortie 2).',
    );
  }
  const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await client.connect();
  await assertRoleApplicatif(client, { attendu });
  return client;
}
