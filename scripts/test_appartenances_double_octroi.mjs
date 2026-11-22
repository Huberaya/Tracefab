#!/usr/bin/env node
/**
 * DEUX LIGNES POUR LA MEME PAIRE DE ROLES : DEUX OCTROIS, OU UN DOUBLON ?
 *
 * La lecture de production a montre DEUX appartenances entre `neondb_owner` et
 * `tracefab_app`, avec des options differentes. Deux lignes pour la meme paire,
 * cela peut vouloir dire deux choses opposees :
 *
 *   a) DEUX OCTROIS DISTINCTS, poses par deux GRANTORS differents. C'est le
 *      comportement attendu depuis PostgreSQL 16 : la cle primaire de
 *      `pg_auth_members` est (roleid, member, grantor), et chaque octroi porte
 *      SES options. Retirer l'un ne retire pas l'autre.
 *   b) UN DOUBLON inexplicable, ou deux lignes dont une seule compte.
 *
 * La difference n'est pas theorique : dans le cas (a), un `REVOKE` qui ne vise
 * pas le bon grantor laisse l'autre octroi en place, et le danger demeure —
 * silencieusement, avec un rapport qui affiche « revoque ».
 *
 * Ce test mesure les trois choses dont depend la remediation :
 *
 *   1. deux GRANT de grantors differents produisent bien DEUX lignes, chacune
 *      avec ses options (donc la duplication observee est explicable) ;
 *   2. `pg_has_role(... 'USAGE')` est vrai des qu'UN octroi actif existe —
 *      il ne dit donc pas « combien » ;
 *   3. `REVOKE ... GRANTED BY x` ne retire QUE l'octroi de x : l'autre survit,
 *      et il faut les deux pour retirer le droit.
 *
 * Ce dernier point est celui qui coute cher en production : on croit avoir
 * revoque, et rien n'a change.
 */
import { PGlite } from '@electric-sql/pglite';

let verifies = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

async function base() {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    CREATE ROLE neondb_owner NOLOGIN BYPASSRLS CREATEROLE;
    CREATE ROLE neon_service NOLOGIN BYPASSRLS CREATEROLE;
    CREATE ROLE tracefab_app LOGIN NOSUPERUSER NOBYPASSRLS;
  `);
  return db;
}

/** Les lignes d'appartenance entre les deux roles, avec grantor et options. */
async function lignes(db) {
  const { rows } = await db.query(`
    SELECT pg_get_userbyid(am.member)  AS membre,
           pg_get_userbyid(am.roleid)  AS accorde,
           pg_get_userbyid(am.grantor) AS grantor,
           am.admin_option,
           to_jsonb(am)->>'inherit_option' AS inherit_option,
           to_jsonb(am)->>'set_option'     AS set_option
      FROM pg_catalog.pg_auth_members am
     WHERE pg_get_userbyid(am.member) IN ('tracefab_app', 'neondb_owner')
       AND pg_get_userbyid(am.roleid) IN ('tracefab_app', 'neondb_owner')
     ORDER BY 1, 2, 3
  `);
  return rows;
}

// --- 1. Deux grantors, deux lignes ---------------------------------------
console.log('1. Deux GRANT de grantors differents : combien de lignes ?');
{
  const db = await base();
  // Premier octroi : par le superutilisateur du cluster (grantor = postgres).
  await db.exec('GRANT neondb_owner TO tracefab_app;');
  const apresUn = await lignes(db);
  console.log(`      apres 1 GRANT : ${apresUn.length} ligne(s) ` +
    apresUn.map((l) => `[${l.membre}<-${l.accorde} par ${l.grantor} inherit=${l.inherit_option} set=${l.set_option}]`).join(' '));
  ok('un GRANT donne UNE ligne', apresUn.length === 1, JSON.stringify(apresUn));

  // Second octroi : il faut un grantor different. On donne a `neon_service`
  // le droit d'administrer `neondb_owner`, puis on octroie depuis ce role.
  await db.exec('GRANT neondb_owner TO neon_service WITH ADMIN OPTION;');
  await db.exec('SET ROLE neon_service;');
  let erreur = null;
  try {
    await db.exec('GRANT neondb_owner TO tracefab_app WITH INHERIT FALSE, SET TRUE;');
  } catch (e) { erreur = e.message; }
  await db.exec('RESET ROLE;');

  const apresDeux = await lignes(db);
  console.log(`      apres 2 GRANT : ${apresDeux.length} ligne(s) ` +
    apresDeux.map((l) => `[${l.membre}<-${l.accorde} par ${l.grantor} inherit=${l.inherit_option} set=${l.set_option}]`).join(' '));

  ok('le second GRANT (grantor different) est accepte', erreur === null, erreur || '');
  ok('la meme paire porte alors DEUX lignes', apresDeux.filter((l) => l.membre === 'tracefab_app').length === 2,
    `${apresDeux.length}`);
  const grantors = new Set(apresDeux.map((l) => l.grantor));
  ok('les deux lignes se distinguent par leur GRANTOR (et non par un doublon)',
    grantors.size === 2, JSON.stringify([...grantors]));
  ok('chaque ligne porte SES options, elles different',
    new Set(apresDeux.map((l) => `${l.inherit_option}/${l.set_option}`)).size === 2,
    JSON.stringify(apresDeux.map((l) => `${l.inherit_option}/${l.set_option}`)));

  // --- 2. Ce que `pg_has_role` repond quand il y a deux octrois ----------
  console.log('\n2. `pg_has_role` dit « oui », pas « combien »');
  const usage = (await db.query(
    `SELECT pg_catalog.pg_has_role('tracefab_app', 'neondb_owner', 'USAGE') AS u,
            pg_catalog.pg_has_role('tracefab_app', 'neondb_owner', 'MEMBER') AS m`,
  )).rows[0];
  ok('USAGE est vrai alors qu un seul des deux octrois herite',
    usage.u === true || usage.u === 't', String(usage.u));
  ok('MEMBER est vrai aussi : les options n effacent pas l arete',
    usage.m === true || usage.m === 't', String(usage.m));

  // --- 3. Le piege : revoquer UN grantor ne suffit pas -------------------
  console.log('\n3. `REVOKE ... GRANTED BY` : le piege de la revocation partielle');
  await db.exec('REVOKE neondb_owner FROM tracefab_app GRANTED BY postgres;');
  const apresRevoke = await lignes(db);
  ok('un seul octroi est retire', apresRevoke.filter((l) => l.membre === 'tracefab_app').length === 1,
    JSON.stringify(apresRevoke.map((l) => l.grantor)));
  const encoreMembre = (await db.query(
    `SELECT pg_catalog.pg_has_role('tracefab_app', 'neondb_owner', 'MEMBER') AS m`,
  )).rows[0].m;
  ok('l application est TOUJOURS membre : la revocation partielle n a rien regle',
    encoreMembre === true || encoreMembre === 't', String(encoreMembre));

  await db.exec('REVOKE neondb_owner FROM tracefab_app GRANTED BY neon_service;');
  const apresTout = await lignes(db);
  const plusMembre = (await db.query(
    `SELECT pg_catalog.pg_has_role('tracefab_app', 'neondb_owner', 'MEMBER') AS m`,
  )).rows[0].m;
  ok('les deux octrois retires, l appartenance disparait', apresTout.filter((l) => l.membre === 'tracefab_app').length === 0,
    JSON.stringify(apresTout));
  ok('et seulement alors `MEMBER` devient faux',
    plusMembre === false || plusMembre === 'f', String(plusMembre));

  await db.close();
}

// --- 4. Cote production : ce que la lecture doit rendre ------------------
console.log('\n4. Ce que la lecture de production doit rendre pour trancher');
{
  const db = await base();
  await db.exec('GRANT neondb_owner TO tracefab_app;');
  await db.exec('GRANT neondb_owner TO neon_service WITH ADMIN OPTION;');
  await db.exec('SET ROLE neon_service;');
  await db.exec('GRANT neondb_owner TO tracefab_app WITH INHERIT FALSE, SET TRUE;');
  await db.exec('RESET ROLE;');

  // La requete exacte a coller en production (lecture seule, une colonne).
  const { rows } = await db.query(`
    SELECT format('appartenance|%s|membre_de|%s|par|%s|admin=%s|herite=%s|setrole=%s',
             m.rolname, r.rolname, pg_get_userbyid(am.grantor),
             am.admin_option::text,
             coalesce(to_jsonb(am)->>'inherit_option', 'n/a'),
             coalesce(to_jsonb(am)->>'set_option', 'n/a')) AS ligne
      FROM pg_catalog.pg_auth_members am
      JOIN pg_catalog.pg_roles m ON m.oid = am.member
      JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
     WHERE m.rolname IN ('tracefab_app') OR r.rolname IN ('tracefab_app')
     ORDER BY 1
  `);
  const sortie = rows.map((r) => r.ligne);
  for (const l of sortie) console.log(`        ${l}`);
  ok('la lecture rend le GRANTOR, sans quoi deux lignes restent inexplicables',
    sortie.length === 2 && sortie.every((l) => /\|par\|/.test(l)), JSON.stringify(sortie));
  ok('elle rend les options de chaque octroi separement',
    sortie.every((l) => /herite=/.test(l) && /setrole=/.test(l)));
  ok('elle voit les deux sens (membre OU accorde egale tracefab_app)',
    sortie.every((l) => l.includes('tracefab_app')));
  await db.close();
}

console.log('\n--------------------------------------------');
if (echecs > 0) {
  console.error(`${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`${verifies} verifications passees.`);
console.log('Deux lignes = deux octrois distincts, et une revocation partielle ne suffit pas.');
