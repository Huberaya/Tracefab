#!/usr/bin/env node
/**
 * Le SQL des PRIVILEGES EFFECTIFS est-il jouable, et mord-il ?
 *
 * `docs/security/2026-10-28-privileges-effectifs-production.sql` sera colle dans
 * l'editeur SQL de Neon, sur la production. Deux choses doivent etre prouvees
 * AVANT : qu'il s'execute, et qu'il DISTINGUE des etats differents.
 *
 * La deuxieme est la seule qui compte. `has_table_privilege` rend toujours
 * quelque chose ; un script qui rend la meme sortie sur une base saine et sur
 * une base trouee ne prouve rien, il rassure.
 *
 * Trois etats sont donc construits sur une base jetable, et la sortie doit
 * changer a chaque fois :
 *
 *   A. sain      : aucun role BYPASSRLS atteignable, aucun droit d'ecriture
 *   B. herite    : l'ecriture arrive par une APPARTENANCE (pas par un GRANT
 *                  direct) — c'est l'heredite qui doit etre vue
 *   C. evasion   : un role BYPASSRLS devient atteignable par SET ROLE — le
 *                  constat grave, celui que `rolbypassrls = false` masque
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ici = dirname(fileURLToPath(import.meta.url));
const FICHIER = join(ici, '..', 'docs', 'security', '2026-10-28-privileges-effectifs-production.sql');

let verifies = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

/** Les instructions reelles : commentaires retires, decoupage sur `;`. */
function instructions() {
  const brut = readFileSync(FICHIER, 'utf8');
  const sansCommentaires = brut.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  return sansCommentaires.split(';').map((q) => q.trim()).filter(Boolean);
}

const sql = instructions();
console.log(`Instructions lues : ${sql.length}`);
sql.forEach((q, i) => console.log(`  [${i + 1}] ${q.split('\n').filter(Boolean)[0].slice(0, 70)}…`));

async function base({ etat }) {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    CREATE ROLE neondb_owner NOLOGIN BYPASSRLS CREATEROLE;
    CREATE ROLE tracefab_app  LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE writeur       NOLOGIN;          -- porte les droits d'ecriture
    CREATE TABLE documents (id int PRIMARY KEY);
    CREATE TABLE tracefab_products (id int PRIMARY KEY);
    CREATE TABLE organization_invitations (id int PRIMARY KEY);
    CREATE TABLE brand_supplier_relationships (id int PRIMARY KEY);
    CREATE TABLE plm_erp_integrations (id int PRIMARY KEY);
    CREATE TABLE plm_erp_sync_jobs (id int PRIMARY KEY);
    CREATE FUNCTION f_saine() RETURNS int LANGUAGE sql AS 'SELECT 1';
    CREATE FUNCTION f_secdef() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
    GRANT USAGE ON SCHEMA public TO tracefab_app;
    GRANT SELECT ON documents, tracefab_products, organization_invitations,
                    brand_supplier_relationships, plm_erp_integrations,
                    plm_erp_sync_jobs TO tracefab_app;
    GRANT EXECUTE ON FUNCTION f_saine() TO tracefab_app;
    GRANT EXECUTE ON FUNCTION f_secdef() TO tracefab_app;
    REVOKE EXECUTE ON FUNCTION f_secdef() FROM PUBLIC;
  `);
  if (etat === 'herite') {
    // L'ecriture n'est pas donnee a l'application : elle arrive par appartenance.
    await db.exec(`
      GRANT INSERT, UPDATE ON documents TO writeur;
      GRANT writeur TO tracefab_app;
    `);
  }
  if (etat === 'evasion') {
    await db.exec(`
      GRANT neondb_owner TO tracefab_app WITH SET TRUE;
    `);
  }
  if (etat === 'public-exec') {
    await db.exec('GRANT EXECUTE ON FUNCTION f_secdef() TO PUBLIC;');
  }
  return db;
}

async function jouer(db, i) {
  const { rows } = await db.query(sql[i]);
  return rows.map((r) => r.ligne);
}

// --- 1. Lecture seule -----------------------------------------------------
console.log('\n1. Le script est en LECTURE SEULE');
{
  const ecriture = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|SET\s+ROLE|COPY)\b/i;
  const coupables = sql.filter((q) => ecriture.test(q));
  ok('aucune instruction d ecriture', coupables.length === 0,
    coupables.map((q) => q.slice(0, 40)).join(' | '));
  ok('aucun SELECT sur une table metier (catalogue systeme seulement)',
    !sql.some((q) => /\bFROM\s+(public\.)?(documents|tracefab_products|organization_invitations|brand_supplier_relationships)\b/i.test(q)));
}

// --- 2. Chaque instruction s'execute, avec le nombre de lignes annonce -----
console.log('\n2. Chaque instruction s execute (PGlite, PostgreSQL 18.6)');
{
  const db = await base({ etat: 'sain' });
  const attendus = [[0, 6], [1, 1], [2, 1]]; // Q1 = 6 tables, Q2 = 1 verdict, Q3 = 1 bilan
  for (const [i, attendu] of attendus) {
    let lignes = null; let erreur = null;
    try { lignes = await jouer(db, i); } catch (e) { erreur = e.message; }
    ok(`instruction ${i + 1} : ${attendu} ligne(s)`, erreur === null && lignes.length === attendu,
      erreur ?? `n=${lignes?.length}`);
    if (lignes) for (const l of lignes) console.log(`        ${l}`);
  }
  // Q4 : 0 ligne est un resultat normal, on verifie seulement qu'elle s'execute.
  let q4 = null; let e4 = null;
  try { q4 = await jouer(db, 3); } catch (e) { e4 = e.message; }
  ok('instruction 4 (privileges par defaut) s execute', e4 === null, e4 ?? '');
  console.log(`        ${q4?.length ?? 0} ligne(s) — 0 est normal`);
  await db.close();
}

// --- 3. La sortie CHANGE avec l'etat (sinon le script ne mesure rien) -----
console.log('\n3. Test par mutation : trois etats, trois sorties');
{
  const lireDroits = (lignes) => Object.fromEntries(lignes.map((l) => {
    const [, table, , droits] = l.split('|');
    return [table, droits.replace('droits=', '')];
  }));

  const a = await base({ etat: 'sain' });
  const sa = lireDroits(await jouer(a, 0));
  const ba = await jouer(a, 1);
  await a.close();
  ok('etat sain : documents en SELECT seul', sa.documents === 'SELECT', sa.documents);
  ok('etat sain : aucun role BYPASSRLS atteignable',
    ba.length === 1 && ba[0].includes('|aucun|'), JSON.stringify(ba));
  ok('etat sain : attribut direct false', ba[0].includes('attribut_direct=false'), ba[0]);

  const b = await base({ etat: 'herite' });
  const sb = lireDroits(await jouer(b, 0));
  await b.close();
  ok('etat herite : l ecriture arrive par APPARTENANCE et le script la voit',
    /INSERT/.test(sb.documents) && /UPDATE/.test(sb.documents), sb.documents);
  ok('l ecriture heritee n apparait QUE sur documents',
    !/INSERT/.test(sb.tracefab_products), sb.tracefab_products);

  const c = await base({ etat: 'evasion' });
  const bc = await jouer(c, 1);
  await c.close();
  ok('etat evasion : un role BYPASSRLS est nomme, avec son grantor',
    bc.length === 1 && bc[0].includes('|neondb_owner|') && /\|par\|/.test(bc[0]), JSON.stringify(bc));
  ok('etat evasion : setrole=true (le chemin reel de l evasion)', bc[0].includes('setrole=true'), bc[0]);
  ok('les trois etats donnent trois sorties differentes',
    JSON.stringify(ba) !== JSON.stringify(bc) && sa.documents !== sb.documents);

  const d = await base({ etat: 'public-exec' });
  const bd = await jouer(d, 2);
  await d.close();
  ok('EXECUTE ouvert a PUBLIC est nomme, pas seulement compte',
    /secdef_exec_public=f_secdef/.test(bd[0]), bd[0]);
}

// --- 4. Aucun role BYPASSRLS exclus par un filtre trop etroit ------------
console.log('\n4. Le filtre de Q2 ne rate pas un role atteignable');
{
  const db = await base({ etat: 'evasion' });
  await db.exec(`
    CREATE ROLE fournisseur_bis NOLOGIN BYPASSRLS;
    GRANT fournisseur_bis TO tracefab_app WITH SET TRUE;
    GRANT writeur TO tracefab_app;  -- une appartenance SANS bypassrls
  `);
  const lignes = await jouer(db, 1);
  await db.close();
  ok('deux roles BYPASSRLS atteignables donnent deux lignes',
    lignes.length === 2 && lignes.every((l) => l.includes('bypass-atteignable|')), JSON.stringify(lignes));
  ok('un role atteignable SANS bypassrls ne pollue pas la sortie',
    !lignes.some((l) => l.includes('writeur')), JSON.stringify(lignes));
  ok('la ligne « aucun » disparait des qu un role est atteignable',
    !lignes.some((l) => l.includes('|aucun|')), JSON.stringify(lignes));
}

console.log('\n--------------------------------------------');
if (echecs > 0) {
  console.error(`${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`${verifies} verifications passees.`);
console.log('Le SQL des privileges effectifs s execute et distingue les trois etats.');
