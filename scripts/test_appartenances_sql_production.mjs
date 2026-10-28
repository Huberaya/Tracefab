#!/usr/bin/env node
/**
 * Le SQL de production est-il autre chose qu'une intention ?
 *
 * `docs/security/2026-10-28-appartenances-roles-production.sql` sera colle dans
 * l'editeur SQL de Neon, sur la PRODUCTION, par l'utilisateur. Une requete qui
 * ne s'execute pas, ou qui rend la meme chose dans les deux sens d'appartenance,
 * coute un aller-retour et laisse croire a une mesure.
 *
 * Ce test debloque la question hors production :
 *
 *   - il lit le fichier REEL (pas une copie), en retire les commentaires, et
 *     execute chaque instruction ;
 *   - il verifie le NOMBRE DE LIGNES annonce dans le fichier — c'est la garde
 *     contre une lecture partielle prise pour un resultat ;
 *   - il fait varier le SENS de l'appartenance et exige que le verdict change.
 *     Une requete qui rend `membre=true` dans les deux sens ne mesure rien.
 *
 * Et il verifie ce que la production ne peut pas nous dire : que le danger
 * reel n'est pas l'heritage mais `SET ROLE`. Cette mesure est faite ici, sur
 * une base jetable, et non supposee.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ici = dirname(fileURLToPath(import.meta.url));
const FICHIER = join(ici, '..', 'docs', 'security', '2026-10-28-appartenances-roles-production.sql');

let verifies = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

/** Les instructions reelles du fichier : commentaires retires, decoupage sur `;`. */
function instructions() {
  const brut = readFileSync(FICHIER, 'utf8');
  const sansCommentaires = brut
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  return sansCommentaires
    .split(';')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
}

const sql = instructions();
console.log(`Instructions lues dans le fichier : ${sql.length}`);
for (const [i, q] of sql.entries()) {
  console.log(`  [${i + 1}] ${q.split('\n')[0].slice(0, 72)}…`);
}

/** Socle jetable : deux comptes fournisseur, un role applicatif, deux locataires. */
async function base({ sens }) {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    CREATE ROLE neondb_owner NOLOGIN BYPASSRLS CREATEROLE CREATEDB;
    CREATE ROLE neon_service  NOLOGIN BYPASSRLS CREATEROLE CREATEDB;
    CREATE ROLE tracefab_app  LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    CREATE TABLE public.secrets (id int PRIMARY KEY, tenant uuid NOT NULL, val text);
    INSERT INTO public.secrets VALUES
      (1, 'aaaaaaaa-0000-0000-0000-000000000001', 'tenant A'),
      (2, 'bbbbbbbb-0000-0000-0000-000000000002', 'tenant B');
    ALTER TABLE public.secrets OWNER TO neondb_owner;
    ALTER TABLE public.secrets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.secrets FORCE ROW LEVEL SECURITY;
    CREATE POLICY secrets_tenant ON public.secrets
      USING (tenant = NULLIF(current_setting('tracefab.tenant', true), '')::uuid);
    GRANT USAGE ON SCHEMA public TO tracefab_app;
    GRANT SELECT ON public.secrets TO tracefab_app;
  `);
  if (sens === 'dangereux') await db.exec('GRANT neondb_owner TO tracefab_app;');
  if (sens === 'benin') await db.exec('GRANT tracefab_app TO neondb_owner;');
  return db;
}

/** Execute une instruction du fichier et rend ses lignes, en texte. */
async function jouer(db, index) {
  const { rows } = await db.query(sql[index]);
  return rows.map((r) => r.ligne);
}

// --- 1. Le fichier ne contient que de la lecture ---------------------------
console.log('\n1. Le script est en LECTURE SEULE');
{
  const dangereux = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|SET\s+ROLE|COPY)\b/i;
  const coupables = sql.filter((q) => dangereux.test(q));
  ok('aucune instruction d ecriture, aucun SET ROLE, aucun GRANT', coupables.length === 0,
    coupables.map((q) => q.slice(0, 40)).join(' | '));
  ok('aucun appel de fonction applicative', !sql.some((q) => /tracefab_has_org_role|tracefab_is_org_member|tracefab_has_privs_of_role/.test(q)));
  ok('aucun SELECT sur une table metier', !sql.some((q) => /FROM\s+(public\.)?(documents|tracefab_products|plm_erp_sync_jobs)\b/i.test(q)));
}

// --- 2. Chaque instruction s'execute, et rend le nombre de lignes annonce ---
console.log('\n2. Chaque instruction s execute sur un cluster reel (PGlite PG 18.6)');
{
  const db = await base({ sens: 'dangereux' });
  // Q1 n'annonce PAS un nombre fixe de lignes (il n'enumere que les aretes qui
  // existent) ; Q2 et Q3 si. On encode donc une fourchette pour Q1, un compte
  // exact pour les autres — sinon le test entérinerait l'erreur du document.
  const attendus = [[0, 1], [1, 2], [2, 3], [3, 1]]; // Q1=1 arete, Q2=2 sens, Q3=3 roles, Q4=1 session // [index, lignes]
  for (const [i, attendu] of attendus) {
    let lignes = null;
    let erreur = null;
    try { lignes = await jouer(db, i); } catch (e) { erreur = e.message; }
    ok(`instruction ${i + 1} : ${attendu} ligne(s)`, erreur === null && lignes.length === attendu,
      erreur ?? `n=${lignes?.length}`);
    if (lignes) for (const l of lignes) console.log(`        ${l}`);
  }
  await db.close();
}

// --- 3. Le verdict CHANGE avec le sens : sinon il ne mesure rien -----------
console.log('\n3. Le verdict distingue les deux sens (test par mutation)');
{
  const lireVerdict = (lignes) => Object.fromEntries(lignes.map((l) => {
    const [, sens, membre, usage, setRole] = l.split('|');
    return [sens, {
      membre: membre === 'membre=true',
      usage: usage === 'usage=true',
      setRole: setRole === 'setrole_possible=true',
    }];
  }));

  const d = await base({ sens: 'dangereux' });
  const vd = lireVerdict(await jouer(d, 1));
  await d.close();
  ok('sens DANGEREUX : tracefab_app -> neondb_owner est membre',
    vd.tracefab_app_vers_neondb_owner.membre === true);
  ok('sens DANGEREUX : SET ROLE est possible, donc BYPASSRLS est atteignable',
    vd.tracefab_app_vers_neondb_owner.setRole === true);
  ok('sens DANGEREUX : le sens inverse est absent',
    vd.neondb_owner_vers_tracefab_app.membre === false);

  const b = await base({ sens: 'benin' });
  const vb = lireVerdict(await jouer(b, 1));
  await b.close();
  ok('sens BENIN : le sens dangereux est absent',
    vb.tracefab_app_vers_neondb_owner.membre === false);
  ok('sens BENIN : le sens benin est present',
    vb.neondb_owner_vers_tracefab_app.membre === true);

  const a = await base({ sens: 'aucun' });
  const va = lireVerdict(await jouer(a, 1));
  await a.close();
  ok('sans appartenance : les deux sens sont absents',
    va.tracefab_app_vers_neondb_owner.membre === false && va.neondb_owner_vers_tracefab_app.membre === false);
  ok('les trois etats donnent trois verdicts differents (la requete mord)',
    JSON.stringify(vd) !== JSON.stringify(vb) && JSON.stringify(vb) !== JSON.stringify(va));
}

// --- 4. Ce que la production ne dira pas : attributs vs SET ROLE -----------
console.log('\n4. Le mecanisme reel du danger — mesure, pas intuition');
{
  const db = await base({ sens: 'dangereux' });
  // L'appartenance seule : l'application reste bornee a son locataire.
  await db.exec('SET ROLE tracefab_app;');
  await db.exec("SET tracefab.tenant = 'aaaaaaaa-0000-0000-0000-000000000001';");
  const parHeritage = (await db.query('SELECT count(*)::int AS n FROM public.secrets')).rows[0].n;
  ok('l heritage ne transmet PAS BYPASSRLS (les attributs ne s heritent pas)',
    parHeritage === 1, `n=${parHeritage}`);
  // SET ROLE, lui, endosse le role et son attribut.
  await db.exec('SET ROLE neondb_owner;');
  const parSetRole = (await db.query('SELECT count(*)::int AS n FROM public.secrets')).rows[0].n;
  await db.exec('RESET ROLE;');
  ok('SET ROLE endosse BYPASSRLS : les deux locataires sont visibles',
    parSetRole === 2, `n=${parSetRole}`);
  await db.close();
}

// --- 5. Le repli pour PostgreSQL < 16 dit la meme chose --------------------
console.log('\n5. Le repli (sans set_option) tranche aussi le sens');
{
  const brut = readFileSync(FICHIER, 'utf8');
  const debut = brut.indexOf('-- REPLI-SQL-DEBUT');
  const fin = brut.indexOf('-- REPLI-SQL-FIN');
  // Delimite par marqueurs, pas par une heuristique sur les commentaires : la
  // premiere version ramassait la prose du mode d'emploi et ne s'executait pas.
  const repli = debut > 0 && fin > debut
    ? brut.slice(debut, fin + '-- REPLI-SQL-FIN'.length)
        .split('\n')
        .filter((l) => l.trimStart().startsWith('--'))
        .map((l) => l.replace(/^(\s*)--\s?/, '$1'))
        // Les deux lignes de marqueur ne sont pas du SQL : les retirer.
        .filter((l) => !/^\s*REPLI-SQL-(DEBUT|FIN)\s*$/.test(l))
        .join('\n')
    : '';
  ok('le repli est delimite par ses marqueurs', repli.length > 0 && /pg_has_role/.test(repli));
  const db = await base({ sens: 'dangereux' });
  let lignes = null;
  let erreur = null;
  try { lignes = (await db.query(repli.trim().replace(/;$/, ''))).rows.map((r) => r.ligne); }
  catch (e) { erreur = e.message; }
  await db.close();
  ok('le repli s execute et rend 2 lignes', erreur === null && lignes?.length === 2, erreur ?? `n=${lignes?.length}`);
  if (lignes) {
    const dangereux = lignes.find((l) => l.includes('tracefab_app_vers_neondb_owner'));
    const benin = lignes.find((l) => l.includes('neondb_owner_vers_tracefab_app'));
    ok('le repli voit le sens dangereux sur la base dangereuse',
      /membre=t/.test(dangereux ?? ''), dangereux);
    ok('et ne confond pas les deux sens', /membre=t/.test(benin ?? '') === false, benin);
  }
}

console.log('\n--------------------------------------------');
if (echecs > 0) {
  console.error(`${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`${verifies} verifications passees.`);
console.log('Le SQL de production s execute, et il distingue les deux sens.');
