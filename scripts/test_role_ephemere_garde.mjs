#!/usr/bin/env node
/**
 * La garde des ROLES ephemeres, PROUVEE — y compris par ses echecs.
 *
 * Symetrique de `test_base_ephemere_garde.mjs`. Un role est plus dangereux
 * qu'une base : c'est un objet de CLUSTER, qui survit a toutes les bases et
 * peut porter des appartenances, des droits par defaut et la propriete
 * d'objets. Six scripts faisaient pourtant `DROP ROLE IF EXISTS <nom fixe>`
 * avant le moindre controle.
 *
 * CE QUI EST PROUVE
 *   1. les noms sont uniques, conformes et tiennent en 63 OCTETS ;
 *   2. un role PREEXISTANT portant le nom candidat n'est JAMAIS detruit : la
 *      garde prend un autre nom, et le role homonyme garde OID et attributs ;
 *   3. le refus vaut aussi pour les identifiants invalides (aucun role cree) ;
 *   4. la destruction ne vise que l'OID cree : nom recycle => refus ;
 *   5. le refus d'une cible non jetable intervient avant toute connexion ;
 *   6. la SONDE reelle (`test_sonde_identite_runtime.mjs`) laisse intact un
 *      role homonyme de son ancien nom fixe — controle negatif de bout en bout.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { deriverUrl } from './lib/ephemeral-db.mjs';
import { nomRoleEphemere, creerRoleEphemere } from './lib/ephemeral-role.mjs';

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
  purpose: 'garde des roles ephemeres — unicite, preuve de propriete, nettoyage',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;

async function maintenance() {
  const url = deriverUrl(urlProprietaire, 'postgres');
  const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await c.connect();
  return c;
}

/** Etat complet d'un role, pour comparer avant/apres. */
async function etatRole(nom) {
  const c = await maintenance();
  try {
    const { rows } = await c.query(
      `SELECT oid, rolname, rolcanlogin, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb
         FROM pg_roles WHERE rolname = $1`,
      [nom],
    );
    return rows[0] ?? null;
  } finally {
    await c.end();
  }
}

async function existe(nom) {
  return (await etatRole(nom)) !== null;
}

const creees = [];
console.log('\n  A. noms de role ephemeres — unicite et conformite');

{
  const noms = new Set(Array.from({ length: 200 }, () => nomRoleEphemere('tf_role')));
  verifier('200 noms sont tous distincts', noms.size === 200, `${noms.size} uniques`);
  verifier(
    'tous conformes a [a-z][a-z0-9_]*',
    [...noms].every((n) => /^[a-z][a-z0-9_]*$/.test(n)),
    [...noms].find((n) => !/^[a-z][a-z0-9_]*$/.test(n)) ?? '',
  );
  verifier(
    'tous tiennent en 63 octets',
    [...noms].every((n) => Buffer.byteLength(n, 'utf8') <= 63),
    `${Math.max(...[...noms].map((n) => Buffer.byteLength(n, 'utf8')))} octets max`,
  );
  const hostiles = ['x"; DROP ROLE postgres; --', '../../etc', 'TRACEFAB-PROD', 'é'.repeat(50)];
  verifier(
    'les prefixes hostiles sont neutralises, jamais injectes',
    hostiles.every((p) => /^[a-z][a-z0-9_]*$/.test(nomRoleEphemere(p))),
    hostiles.map((p) => nomRoleEphemere(p)).join(' | '),
  );
}

console.log('\n  B. creation, preuve d OID, destruction');

{
  const role = await creerRoleEphemere({
    urlProprietaire,
    prefixe: 'tf_role_simple',
    attributs: { login: true, motDePasse: 'jetable_local', bypassrls: false },
  });
  creees.push(role);
  const etat = await etatRole(role.nom);
  verifier('le role existe apres creation', etat !== null, role.nom);
  verifier('son OID est celui releve par la garde', String(etat?.oid) === role.oid, `${etat?.oid} vs ${role.oid}`);
  verifier('il porte les attributs demandes (LOGIN, sans BYPASSRLS)',
    etat?.rolcanlogin === true && etat?.rolbypassrls === false,
    `login=${etat?.rolcanlogin} bypassrls=${etat?.rolbypassrls}`);
  await role.fermer();
  creees.pop();
  verifier('apres fermeture, le role a disparu', !(await existe(role.nom)), role.nom);
}

console.log('\n  C. role HOMONYME preexistant — jamais detruit');

{
  // Un role homonyme, avec des attributs qu'on reconnaitrait s'ils changeaient.
  const homonyme = nomRoleEphemere('tf_role_homonyme');
  const c = await maintenance();
  await c.query(`CREATE ROLE "${homonyme}" LOGIN BYPASSRLS PASSWORD 'homonyme_local'`);
  await c.end();
  const avant = await etatRole(homonyme);
  verifier('temoin : le role homonyme existe avant l epreuve', avant !== null, homonyme);

  // On force la garde a viser CE nom : elle doit refuser et prendre un autre nom.
  let tours = 0;
  const role = await creerRoleEphemere({
    urlProprietaire,
    prefixe: 'tf_role_collision',
    generateurNom: () => (tours += 1) === 1 ? homonyme : nomRoleEphemere('tf_role_repli'),
  });
  creees.push(role);

  const apres = await etatRole(homonyme);
  verifier('la garde n a pas pris le nom deja occupe', role.nom !== homonyme, role.nom);
  verifier('le role homonyme existe toujours', apres !== null, 'disparu');
  verifier('son OID n a pas change', String(apres?.oid) === String(avant?.oid), `${avant?.oid} → ${apres?.oid}`);
  verifier('ses attributs sont intacts (LOGIN + BYPASSRLS)',
    apres?.rolcanlogin === true && apres?.rolbypassrls === true,
    `login=${apres?.rolcanlogin} bypassrls=${apres?.rolbypassrls}`);

  await role.fermer();
  creees.pop();
  const final = await etatRole(homonyme);
  verifier('apres la fermeture de la garde, l homonyme est encore la', final !== null, 'disparu');
  verifier('toujours avec le meme OID', String(final?.oid) === String(avant?.oid), `${final?.oid}`);

  const c2 = await maintenance();
  await c2.query(`DROP ROLE "${homonyme}"`);
  await c2.end();
}

console.log('\n  D. nom recycle — la destruction est refusee');

{
  const role = await creerRoleEphemere({ urlProprietaire, prefixe: 'tf_role_recycle' });
  const nom = role.nom;
  // On detruit le role puis on en recree un AUTRE du meme nom, comme le ferait
  // une execution concurrente : l'OID change, la garde ne doit plus toucher.
  const c = await maintenance();
  await c.query(`DROP ROLE "${nom}"`);
  await c.query(`CREATE ROLE "${nom}" NOLOGIN`);
  await c.end();
  let refus = null;
  try {
    await role.fermer();
  } catch (e) {
    refus = e;
  }
  verifier('la garde refuse de detruire un role dont l OID a change',
    refus !== null && /OID/.test(refus.message), refus?.message ?? 'destruction acceptee');
  verifier('le role recycle est toujours la', await existe(nom), nom);

  const c2 = await maintenance();
  await c2.query(`DROP ROLE "${nom}"`);
  await c2.end();
}

console.log('\n  E. echec de creation — rien ne reste derriere');

{
  let erreur = null;
  try {
    await creerRoleEphemere({
      urlProprietaire,
      prefixe: 'tf_role_invalide',
      // Un identifiant que la garde doit refuser avant tout DROP.
      generateurNom: () => '1 interdit; DROP ROLE postgres',
    });
  } catch (e) {
    erreur = e;
  }
  verifier('un identifiant invalide fait echouer la garde', erreur !== null, 'aucune erreur');
  verifier(
    'aucun role n a ete cree avec ce prefixe',
    !(await existe('tf_role_invalide')),
    'role cree malgre le refus',
  );
}

console.log('\n  F. cible non jetable — refus avant toute connexion');

{
  let refus = null;
  try {
    await creerRoleEphemere({
      urlProprietaire: 'postgresql://user:pw@ep-exemple.eu-central-1.aws.neon.tech/neondb',
      prefixe: 'tf_role_refus',
    });
  } catch (e) {
    refus = e;
  }
  verifier('un hote manage est refuse', refus !== null && /non autorisee/.test(refus.message),
    refus?.message ?? 'accepte');
}

console.log('\n  G. la SONDE reelle laisse intact un role homonyme de son ancien nom');

{
  // `tracefab_sonde_soumis` etait le nom FIXE de la sonde, precede d'un
  // `DROP ROLE IF EXISTS`. On le recree avec des attributs reconnaissables :
  // la sonde ne doit ni le detruire ni le modifier.
  const ancienNom = 'tracefab_sonde_soumis';
  const c = await maintenance();
  await c.query(`DROP ROLE IF EXISTS "${ancienNom}"`);
  await c.query(`CREATE ROLE "${ancienNom}" NOLOGIN PASSWORD 'temoin_intact'`);
  await c.end();
  const avant = await etatRole(ancienNom);

  const r = spawnSync(process.execPath, [join(RACINE, 'scripts', 'run-db-suite.mjs'),
    'scripts/test_sonde_identite_runtime.mjs'], { encoding: 'utf8', env: process.env });
  verifier('la sonde aboutit malgre le role homonyme preexistant', r.status === 0,
    `exit=${r.status} ${(r.stdout || '').split('\n').filter((l) => /ECHEC/.test(l)).slice(0, 2).join(' ')}`);

  const apres = await etatRole(ancienNom);
  verifier('le role homonyme survit a la sonde', apres !== null, 'detruit');
  verifier('son OID est inchange', String(apres?.oid) === String(avant?.oid), `${avant?.oid} → ${apres?.oid}`);
  verifier('ses attributs sont inchanges (NOLOGIN)',
    apres?.rolcanlogin === false && apres?.rolbypassrls === false,
    `login=${apres?.rolcanlogin} bypassrls=${apres?.rolbypassrls}`);

  const c2 = await maintenance();
  await c2.query(`DROP ROLE "${ancienNom}"`);
  await c2.end();
}

console.log('\n  H. nettoyage — aucun role de sonde ne subsiste');

{
  for (const role of creees.splice(0)) await role.fermer().catch(() => {});
  const c = await maintenance();
  const { rows } = await c.query(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'tf\\_role\\_%' OR rolname LIKE 'tf\\_sonde\\_%'",
  );
  await c.end();
  verifier('aucun role ephemere residuel', rows.length === 0, rows.map((r) => r.rolname).join(', '));
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — un rôle préexistant ne peut pas être détruit par une suite.\n');
process.exit(0);
