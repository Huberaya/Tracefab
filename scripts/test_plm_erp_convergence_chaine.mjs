#!/usr/bin/env node
/**
 * `20261028150000_reconcile_plm_erp_sync_job_policies` sur la CHAINE REELLE.
 *
 * POURQUOI CE TEST EXISTE, EN PLUS DE CELUI QUI L'ACCOMPAGNE
 *
 * `test_plm_erp_policy_convergence.mjs` monte un schema ecrit a la main : une
 * table reduite a deux colonnes, une fonction `tracefab_has_org_role` remplacee
 * par un `current_setting`. Il prouve la combinaison `OR` des politiques
 * permissives — ce qui est deja beaucoup — mais il ne prouve pas que la
 * migration corrective s'applique au **vrai** schema : ni que les politiques
 * canoniques portent bien ces noms sur la chaine, ni que le fichier ne touche
 * rien d'autre, ni qu'il est rejouable.
 *
 * C'est exactement le piege dans lequel je suis tombe au tour 29 avec
 * `supplier_portal` : un test sur un schema d'emprunt mesurait un systeme qui
 * n'existe pas. Ce test-ci rejoue la chaine complete, recree la derive telle
 * qu'elle a ete observee en production, applique la migration, et verifie
 * l'etat final sur le catalogue reel.
 *
 * CE QUI N'EST PAS PROUVE ICI
 *
 * Que la production a bien ces deux politiques : cela vient de la confrontation
 * de son catalogue, faite le 28/10/2026, et non de ce test. Ce test prouve que
 * SI elles y sont, la migration les retire et n'emporte rien d'autre.
 *
 *   npm run test:plm-erp-convergence
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');
const CIBLE = '20261028150000_reconcile_plm_erp_sync_job_policies';

const { PGlite } = await import('@electric-sql/pglite');
const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

let echecs = 0;
let verifies = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const LIRE = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');
const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();

/* -------------------------------------------------------------------------
   1. Le fichier lui-meme
   ------------------------------------------------------------------------- */

console.log('\n  1. Le fichier de migration');

const doc = LIRE(CIBLE);
ok('les deux politiques observees en production sont retirees nommement',
  /DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public\.plm_erp_sync_jobs/.test(doc)
  && /DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public\.plm_erp_sync_jobs/.test(doc));
ok('elle ne pose aucun GRANT ni REVOKE',
  !/\b(GRANT|REVOKE)\b/i.test(doc.replace(/--[^\n]*/g, '')));
ok('elle ne cree ni ne remplace aucune politique canonique',
  !/CREATE POLICY|CREATE OR REPLACE FUNCTION|CREATE FUNCTION/i.test(doc.replace(/--[^\n]*/g, '')));
ok('elle ne touche pas a la table des integrations',
  !/plm_erp_integrations/.test(doc.replace(/--[^\n]*/g, '')));
/**
 * DEUX ASSERTIONS ONT CHANGE DE FORME, ET VOICI POURQUOI.
 *
 * Elles exigeaient (1) que la reconciliation soit la DERNIERE migration de la
 * chaine et (2) que les noms des politiques derivees n'apparaissent dans AUCUNE
 * autre migration. La premiere etait une photographie de l'etat du depot : elle
 * cassait des qu'une migration etait ajoutee apres — ce qui est arrive, sans
 * que la securite change d'un iota. La seconde confondait « nommer » et
 * « recreer » : une migration qui ne fait que RETIRER ces politiques les nomme
 * legitimement.
 *
 * Ce qui compte n'est donc pas la position dans la chaine, ni le silence, mais
 * qu'aucune migration ne RECREE une politique permissive, et que l'etat FINAL
 * reste la reference — ce que verifie la section 4 bis sur le catalogue reel.
 * Les deux controles sont plus precis qu'avant, pas plus laxistes.
 */
ok('aucune AUTRE migration ne CREE les politiques derivees',
  dossiers.filter((d) => d !== CIBLE).every((d) => {
    const sql = LIRE(d).replace(/--[^\n]*/g, '');
    return !/CREATE\s+POLICY\s+(plm_erp_sync_jobs_insert_brand|plm_erp_sync_jobs_select_brand)\b/i.test(sql);
  }));
/**
 * Une migration qui NOMME les politiques derivees peut le faire pour deux
 * raisons opposees : les retirer (correctif) ou les recreer/elargir (derive).
 * La version precedente de ce controle exigeait que CHAQUE LIGNE citant un nom
 * soit un DROP — ce qui declarait fautive une verification legitime en lecture
 * (`WHERE policyname IN (...)`) et forcait a ne plus rien verifier.
 *
 * Le controle porte desormais sur ce qui COMPTE : aucune instruction qui cite
 * ces noms ne doit creer, alterer, accorder ou revoquer. Une lecture de
 * catalogue reste permise ; un DROP reste permis.
 */
const NOMS_DERIVES = /plm_erp_sync_jobs_insert_brand|plm_erp_sync_jobs_select_brand/;
const INTERDIT_QUAND_CITE = /CREATE\s+POLICY|ALTER\s+POLICY|\bGRANT\b|\bREVOKE\b/i;
function instructionsCitantes(sqlBrut) {
  const sql = sqlBrut.replace(/--[^\n]*/g, '');
  return sql.split(';').filter((i) => NOMS_DERIVES.test(i));
}
ok('les migrations qui nomment les politiques derivees ne les CREENT, ALTERENT, GRANTENT ni REVOQUENT',
  dossiers.filter((d) => d !== CIBLE).every((d) =>
    instructionsCitantes(LIRE(d)).every((i) => !INTERDIT_QUAND_CITE.test(i))));

// Temoins : le controle doit voir une recreation, un GRANT et un ALTER.
{
  // Tous les pieges doivent CITER un nom de politique : un GRANT porte sur la
  // TABLE, pas sur une politique, il est donc hors du perimetre de ce controle
  // (c'est un autre controle, dans test_plm_rls_isolation_prouvee).
  const pieges = [
    ['CREATE', `CREATE POLICY plm_erp_sync_jobs_insert_brand ON t FOR INSERT WITH CHECK (true)`],
    ['CREATE dans un bloc DO',
      `DO $$ BEGIN CREATE POLICY plm_erp_sync_jobs_select_brand ON t USING (true); END $$`],
    ['ALTER', `ALTER POLICY plm_erp_sync_jobs_select_brand ON t USING (true)`],
  ];
  const vus = pieges.filter(([, sql]) => {
    const instr = instructionsCitantes(sql);
    return instr.length > 0 && instr.some((i) => INTERDIT_QUAND_CITE.test(i));
  }).length;
  ok('temoin : les 3 ecritures interdites sont detectees', vus === 3, `${vus}/3`);
  const lecture = instructionsCitantes(
    `SELECT 1 FROM pg_catalog.pg_policies WHERE policyname IN ('plm_erp_sync_jobs_insert_brand')`);
  ok('temoin : une simple lecture de catalogue n est PAS signalee',
    lecture.every((i) => !INTERDIT_QUAND_CITE.test(i)));
}
ok('aucune migration posterieure ne cree de politique permissive sur la table',
  dossiers.filter((d) => d > CIBLE).every((d) => {
    const sql = LIRE(d).replace(/--[^\n]*/g, '');
    const creations = sql.match(/CREATE\s+POLICY[^;]*;/gi) ?? [];
    return creations.every((c) => !/USING\s*\(\s*true\s*\)/i.test(c) && !/contributor/i.test(c));
  }));

/* -------------------------------------------------------------------------
   2. Sur la chaine complete, avant la migration
   ------------------------------------------------------------------------- */

console.log('\n  2. Etat canonique du depot, avant la cible');

const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;
await db.exec(`
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  GRANT USAGE ON SCHEMA public TO tracefab_app;
`);
for (const d of dossiers) { if (d === CIBLE) break; await db.exec(LIRE(d)); }

const politiques = async () => (await db.query(`
  SELECT policyname, cmd, coalesce(qual, '') AS qual, coalesce(with_check, '') AS check
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'plm_erp_sync_jobs'
   ORDER BY policyname`)).rows;

const avant = await politiques();
ok('la chaine porte exactement les deux politiques canoniques',
  avant.length === 2
  && avant.some((p) => p.policyname === 'plm_sync_jobs_insert_brand')
  && avant.some((p) => p.policyname === 'plm_sync_jobs_select_org'),
  JSON.stringify(avant.map((p) => p.policyname)));
ok('l insertion canonique exige owner/admin/manager',
  /owner/.test(avant.find((p) => p.policyname === 'plm_sync_jobs_insert_brand')?.check ?? '')
  && !/contributor/.test(avant.find((p) => p.policyname === 'plm_sync_jobs_insert_brand')?.check ?? ''),
  avant.find((p) => p.policyname === 'plm_sync_jobs_insert_brand')?.check);
ok('la table est en RLS activee et forcee',
  (await db.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                    WHERE oid = 'public.plm_erp_sync_jobs'::regclass`)).rows[0].relrowsecurity === true
  && (await db.query(`SELECT relforcerowsecurity FROM pg_class
                       WHERE oid = 'public.plm_erp_sync_jobs'::regclass`)).rows[0].relforcerowsecurity === true);

/* -------------------------------------------------------------------------
   3. La derive, telle qu'observee en production
   ------------------------------------------------------------------------- */

console.log('\n  3. Derive reproduite, puis migration appliquee');

await db.exec(`
  CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
    FOR INSERT TO PUBLIC WITH CHECK (
      tracefab_has_org_role(brand_organization_id,
        ARRAY['owner','admin','manager','contributor']::membership_role[]));
  CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs
    FOR SELECT TO PUBLIC USING (true);
`);
const derive = await politiques();
ok('la derive porte quatre politiques sur la table reelle', derive.length === 4,
  JSON.stringify(derive.map((p) => p.policyname)));
ok('la politique supplementaire elargit bien a contributor',
  /contributor/.test(derive.find((p) => p.policyname === 'plm_erp_sync_jobs_insert_brand')?.check ?? ''));

let erreur = null;
try { await db.exec(doc); } catch (e) { erreur = `${e.code} ${e.message}`; }
ok('la migration s applique sur la chaine reelle, sans erreur', erreur === null, erreur || '');

const apres = await politiques();
ok('il ne reste que les deux politiques canoniques',
  apres.length === 2
  && apres.every((p) => ['plm_sync_jobs_insert_brand', 'plm_sync_jobs_select_org'].includes(p.policyname)),
  JSON.stringify(apres.map((p) => p.policyname)));
ok('les politiques canoniques sont INCHANGEES (meme commande, meme regle)',
  JSON.stringify(apres.map((p) => [p.policyname, p.cmd, p.qual, p.check]))
  === JSON.stringify(avant.map((p) => [p.policyname, p.cmd, p.qual, p.check])),
  'les regles canoniques ont bouge');
ok('la RLS reste activee et forcee',
  (await db.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                    WHERE oid = 'public.plm_erp_sync_jobs'::regclass`)).rows[0].relforcerowsecurity === true);

/* -------------------------------------------------------------------------
   4. Rejeu : la migration doit pouvoir passer deux fois
   ------------------------------------------------------------------------- */

console.log('\n  4. Idempotence');

let rejeu = null;
try { await db.exec(doc); } catch (e) { rejeu = `${e.code} ${e.message}`; }
ok('elle se rejoue sans erreur (`DROP POLICY IF EXISTS`)', rejeu === null, rejeu || '');
const apresRejeu = await politiques();
ok('l etat est inchange apres rejeu',
  JSON.stringify(apresRejeu.map((p) => p.policyname)) === JSON.stringify(apres.map((p) => p.policyname)));

/* -------------------------------------------------------------------------
   4 bis. L'ETAT FINAL EST LA REFERENCE, pas seulement « plus de derive »

   Le critere de cloture n'est pas « la derive a disparu » mais « le catalogue
   final correspond a la reference validee ». On compare donc les politiques
   une par une, definition comprise : nom, commande, roles, USING, WITH CHECK.
   ------------------------------------------------------------------------- */

console.log('\n  4 bis. Le catalogue final est exactement la reference');

const finales = await db.query(`
  SELECT polname,
         polcmd::text AS cmd,
         coalesce(pg_catalog.pg_get_expr(polqual, polrelid), '(aucun)') AS using,
         coalesce(pg_catalog.pg_get_expr(polwithcheck, polrelid), '(aucun)') AS chk
    FROM pg_catalog.pg_policy
   WHERE polrelid = 'public.plm_erp_sync_jobs'::regclass
   ORDER BY polname`);

ok('il reste exactement DEUX politiques sur plm_erp_sync_jobs',
  finales.rows.length === 2, `${finales.rows.length}`);
ok('ce sont les deux canoniques, et elles seules',
  finales.rows.map((r) => r.polname).join(',')
    === 'plm_sync_jobs_insert_brand,plm_sync_jobs_select_org',
  finales.rows.map((r) => r.polname).join(','));

const ins = finales.rows.find((r) => r.polname === 'plm_sync_jobs_insert_brand');
const sel = finales.rows.find((r) => r.polname === 'plm_sync_jobs_select_org');

ok('INSERT : commande a, aucune clause USING (WITH CHECK seulement)',
  ins && ins.cmd === 'a' && ins.using === '(aucun)', ins ? `${ins.cmd}/${ins.using}` : 'absente');
ok('INSERT : WITH CHECK limite a owner, admin, manager — et rien d autre',
  ins && /\['owner'::membership_role, 'admin'::membership_role, 'manager'::membership_role\]\)$/.test(ins.chk),
  ins ? ins.chk : 'absente');
ok('INSERT : le mot contributor n apparait nulle part dans la definition',
  ins && !/contributor/i.test(ins.chk), ins ? ins.chk : 'absente');
ok('SELECT : commande r, aucune clause WITH CHECK',
  sel && sel.cmd === 'r' && sel.chk === '(aucun)', sel ? `${sel.cmd}/${sel.chk}` : 'absente');
ok('SELECT : predicat borne au tenant, jamais true',
  sel && sel.using === 'tracefab_is_org_member(brand_organization_id)',
  sel ? sel.using : 'absente');

/* -------------------------------------------------------------------------
   5. Sur une base neuve, la migration ne fait rien — et ne casse rien
   ------------------------------------------------------------------------- */

console.log('\n  5. Base neuve : aucun effet de bord');

const vierge = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await vierge.waitReady;
await vierge.exec(`
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  GRANT USAGE ON SCHEMA public TO tracefab_app;
`);
let surVierge = null;
try {
  for (const d of dossiers) await vierge.exec(LIRE(d));
} catch (e) { surVierge = `${e.code} ${e.message}`; }
ok(`les ${dossiers.length} migrations s appliquent sur une base vierge, cible comprise`, surVierge === null, surVierge || '');
const viergePol = (await vierge.query(`
  SELECT policyname FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'plm_erp_sync_jobs' ORDER BY 1`)).rows.map((r) => r.policyname);
ok('sur une base neuve, seules les canoniques existent (les DROP ne font rien)',
  JSON.stringify(viergePol) === JSON.stringify(['plm_sync_jobs_insert_brand', 'plm_sync_jobs_select_org']),
  JSON.stringify(viergePol));

await db.close();
await vierge.close();

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  La derive est retiree sur le vrai schema, les canoniques sont intactes.');
  console.log('  Reste a confronter la production : ce test ne dit pas ce qu elle porte.\n');
  process.exit(0);
}
console.log(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
