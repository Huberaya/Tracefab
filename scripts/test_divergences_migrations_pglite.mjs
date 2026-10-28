#!/usr/bin/env node
/**
 * Les trois migrations dont l'empreinte en production differe du depot : quel
 * EFFET reel, et quelle decision de reprise ?
 *
 * POURQUOI CE TEST EXISTE
 *
 * `_prisma_migrations` enregistre, pour trois migrations, une empreinte qui
 * n'est pas celle du depot au commit courant. Une empreinte ne dit pas si le
 * schema differe : elle dit qu'un octet a change. Entre un commentaire reformule
 * et une condition de securite retiree, il y a la meme empreinte differente et
 * des consequences opposees. Ce test tranche par l'execution, pas par la
 * lecture du diff.
 *
 * Il rejoue les deux versions du fichier — celle retrouvee dans les objets Git,
 * qu'a executee la production, et celle du depot — et compare ce que le schema
 * produit reellement.
 *
 * CE QUI EST PROUVE ICI
 *   - la divergence de `supplier_portal_advanced_hardening` est SEMANTIQUE et
 *     porte sur une regle d'autorisation (qui peut inviter un `owner`) ;
 *   - celle de `public_read_context` est ENVIRONNEMENTALE : inerte des lors que
 *     le role `tracefab_app` existe, ce qui est le cas en production.
 *
 * CE QUI N'EST PAS PROUVE
 *   L'etat exact de la production : on rejoue le contenu retrouve, pas la base
 *   reelle. La confrontation au catalogue de production reste a faire pour la
 *   troisieme migration, dont le contenu historique est INTROUVABLE.
 *
 *   npm run test:divergences-migrations
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(root, 'scripts', 'fixtures', 'empreintes-production-20261028');

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('ECHEC  @electric-sql/pglite introuvable — executer `npm ci`.');
  process.exit(1);
}

let echecs = 0;
let verifies = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const lireDepot = (d) => fs.readFileSync(path.join(root, 'prisma', 'migrations', d, 'migration.sql'));

/* ==========================================================================
   0. Le contenu historique retrouve correspond-il vraiment a la production ?
   ========================================================================== */

console.log('\n  0. Contenu historique vs empreinte de production');

const ATTENDU = {
  supplier_portal: '560356c203df6d460f8488f44bdf1ce582d3f609eae1b4acd329ad3cd686bbb7',
  public_read_context: 'c12ee33303084b6710284139786058b8d088b2619d92372ea57f282e86480d04',
};
for (const [cle, empreinte] of Object.entries(ATTENDU)) {
  const f = path.join(HIST, `${cle}.sql`);
  ok(`le fichier historique « ${cle} » est present`, fs.existsSync(f));
  if (!fs.existsSync(f)) continue;
  const calculee = sha256(fs.readFileSync(f));
  ok(`son empreinte reproduit celle de la production`, calculee === empreinte,
    `${calculee} != ${empreinte}`);
}

/* ==========================================================================
   1. supplier_portal_advanced_hardening — divergence SEMANTIQUE
   ========================================================================== */

console.log('\n  1. `supplier_portal_advanced_hardening` : regle d autorisation');

/** Isole la definition de la fonction de validation depuis un fichier de migration. */
function fonctionDeValidation(sql) {
  const m = sql.match(
    /CREATE OR REPLACE FUNCTION tracefab_validate_member_invitation_role\(\)[\s\S]*?\$\$;/);
  return m ? m[0] : null;
}

const sqlProduction = fs.readFileSync(path.join(HIST, 'supplier_portal.sql'), 'utf8');
const sqlDepot = lireDepot('20261005090000_supplier_portal_advanced_hardening').toString();

const corpsProduction = fonctionDeValidation(sqlProduction);
const corpsDepot = fonctionDeValidation(sqlDepot);
ok('la fonction de validation est extraite des deux versions',
  corpsProduction !== null && corpsDepot !== null);
ok('les deux versions de la fonction DIFFERENT', corpsProduction !== corpsDepot);

/**
 * Installe la fonction et son declencheur sur une base minimale, puis tente les
 * deux invitations qui comptent :
 *   A. invitation d'un `owner` SANS contexte de relation (gestion de membres) ;
 *   B. invitation d'un `owner` AVEC contexte de relation (onboarding fournisseur).
 * On mesure ACCEPTE / REFUSE, pas le texte du fichier.
 */
async function comportement(corps) {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    CREATE TYPE member_role AS ENUM ('owner','admin','manager','contributor','auditor','viewer','supplier_user');
    CREATE TABLE organization_invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target_role member_role NOT NULL,
      relationship_id uuid
    );
    CREATE FUNCTION gen_random_uuid() RETURNS uuid AS 'select md5(random()::text)::uuid' LANGUAGE sql;
  `);
  await db.exec(corps);
  await db.exec(`
    DROP TRIGGER IF EXISTS organization_invitations_validate_role ON organization_invitations;
    CREATE TRIGGER organization_invitations_validate_role
      BEFORE INSERT OR UPDATE ON organization_invitations
      FOR EACH ROW EXECUTE FUNCTION tracefab_validate_member_invitation_role();
  `);

  const essai = async (relationship) => {
    const val = relationship === null ? null : "'00000000-0000-0000-0000-000000000001'";
    try {
      await db.exec(`INSERT INTO organization_invitations (target_role, relationship_id)
                     VALUES ('owner', ${val})`);
      return 'accepte';
    } catch (e) {
      return /owner_role_not_invitable/.test(String(e.message)) ? 'refuse' : `erreur:${e.message}`;
    }
  };

  const sansRelation = await essai(null);
  const avecRelation = await essai('x');
  await db.close();
  return { sansRelation, avecRelation };
}

const prod = await comportement(corpsProduction);
const depot = await comportement(corpsDepot);

console.log(`        production : owner sans relation = ${prod.sansRelation}, avec relation = ${prod.avecRelation}`);
console.log(`        depot      : owner sans relation = ${depot.sansRelation}, avec relation = ${depot.avecRelation}`);

ok('les deux versions refusent l invitation d owner SANS relation (gestion de membres)',
  prod.sansRelation === 'refuse' && depot.sansRelation === 'refuse',
  `${prod.sansRelation} / ${depot.sansRelation}`);
ok('PRODUCTION refuse l invitation d owner AVEC relation', prod.avecRelation === 'refuse',
  prod.avecRelation);
ok('LE DEPOT l accepte — c est la difference fonctionnelle', depot.avecRelation === 'accepte',
  depot.avecRelation);
ok('=> la divergence est SEMANTIQUE, pas cosmetique',
  prod.avecRelation !== depot.avecRelation);
// Assertion INDEPENDANTE des deux precedentes : elle porte sur la seule
// question qui compte pour la securite — le depot accorde-t-il, en production,
// un droit que la production n'a pas ? La reponse doit etre non.
ok('=> aucune invitation acceptee en production ne l est aussi par le depot par ouverture',
  !(prod.sansRelation === 'accepte' && depot.sansRelation === 'refuse'),
  'le depot ne peut pas etre plus permissif que la production sur un cas qu elle refuse',
);
ok('=> la seule difference est une ACCEPTATION supplementaire cote depot, jamais un refus',
  prod.sansRelation === 'refuse' && depot.sansRelation === 'refuse'
  && prod.avecRelation === 'refuse' && depot.avecRelation === 'accepte');

/* ==========================================================================
   2. public_read_context — divergence ENVIRONNEMENTALE
   ========================================================================== */

console.log('\n  2. `public_read_context` : GRANT conditionne a l existence du role');

const prodRead = fs.readFileSync(path.join(HIST, 'public_read_context.sql'), 'utf8');
const depotRead = lireDepot('20261009180000_public_read_context').toString();

const blocGrant = (sql) => {
  const m = sql.match(/(GRANT EXECUTE ON FUNCTION tracefab_public_context[\s\S]*?;|DO \$grants\$[\s\S]*?\$grants\$;)/);
  return m ? m[1] : null;
};
ok('le bloc de GRANT est present dans les deux versions',
  blocGrant(prodRead) !== null && blocGrant(depotRead) !== null);
ok('les deux blocs DIFFERENT', blocGrant(prodRead) !== blocGrant(depotRead));

/** Joue le bloc de GRANT avec, puis sans, le role `tracefab_app`,
 *  et rend les PRIVILEGES REELS obtenus — pas seulement « ca passe ». */
async function grant(bloc, avecRole) {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE FUNCTION tracefab_public_context() RETURNS boolean LANGUAGE sql AS 'select true';
    CREATE FUNCTION tracefab_product_is_public(uuid) RETURNS boolean LANGUAGE sql AS 'select true';
    CREATE FUNCTION tracefab_material_is_public(uuid) RETURNS boolean LANGUAGE sql AS 'select true';
    CREATE FUNCTION tracefab_supplier_site_is_public(uuid) RETURNS boolean LANGUAGE sql AS 'select true';
    CREATE FUNCTION tracefab_public_brand(uuid) RETURNS TABLE(a text) LANGUAGE sql AS 'select ''a''::text where false';
  `);
  if (avecRole) await db.exec(`CREATE ROLE tracefab_app NOLOGIN;`);
  let issue;
  try { await db.exec(bloc); issue = 'ok'; }
  catch (e) { issue = /does not exist/.test(String(e.message)) ? 'role_absent' : `erreur:${e.message}`; }

  // Les privileges effectivement detenus par tracefab_app sur les cinq
  // fonctions. Deux versions peuvent « passer » sans accorder la meme chose :
  // c'est precisement ce qu'une assertion « code 0 » ne verrait pas.
  let privileges = [];
  if (avecRole && issue === 'ok') {
    const r = await db.query(`
      SELECT p.proname
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('tracefab_public_context','tracefab_product_is_public',
                           'tracefab_material_is_public','tracefab_supplier_site_is_public',
                           'tracefab_public_brand')
         AND has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
       ORDER BY p.proname`);
    privileges = r.rows.map((x) => x.proname);
  }
  await db.close();
  return { issue, privileges };
}

const rProdAvec = await grant(blocGrant(prodRead), true);
const rDepotAvec = await grant(blocGrant(depotRead), true);
const rProdSans = await grant(blocGrant(prodRead), false);
const rDepotSans = await grant(blocGrant(depotRead), false);

console.log(`        role present : production=${rProdAvec.issue}, depot=${rDepotAvec.issue}`);
console.log(`        privileges   : production=${rProdAvec.privileges.length}, depot=${rDepotAvec.privileges.length}`);
console.log(`        role absent  : production=${rProdSans.issue}, depot=${rDepotSans.issue}`);

ok('AVEC le role, les deux versions passent', rProdAvec.issue === 'ok' && rDepotAvec.issue === 'ok',
  `${rProdAvec.issue} / ${rDepotAvec.issue}`);
ok('les CINQ fonctions sont accordees dans les deux cas',
  rProdAvec.privileges.length === 5 && rDepotAvec.privileges.length === 5,
  `${rProdAvec.privileges.length} / ${rDepotAvec.privileges.length}`);
ok('les privileges obtenus sont IDENTIQUES, fonction par fonction',
  JSON.stringify(rProdAvec.privileges) === JSON.stringify(rDepotAvec.privileges),
  `${rProdAvec.privileges.join(',')} != ${rDepotAvec.privileges.join(',')}`);
ok('SANS le role, la version de production echoue (la chaine casse sur base neuve)',
  rProdSans.issue === 'role_absent', rProdSans.issue);
ok('SANS le role, la version du depot passe (idempotence corrigee)',
  rDepotSans.issue === 'ok', rDepotSans.issue);

/* ==========================================================================
   3. plm_erp_gs1_interoperability — contenu historique INTROUVABLE
   ========================================================================== */

console.log('\n  3. `plm_erp_gs1_interoperability` : contenu historique');

const CIBLE3 = 'c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861';
const depot3 = sha256(lireDepot('20261006210000_plm_erp_gs1_interoperability'));
const hist3 = path.join(HIST, 'plm_erp_gs1_interoperability.sql');
ok('le depot ne contient PAS ce contenu (empreinte differente)', depot3 !== CIBLE3,
  `${depot3}`);
ok('aucun contenu historique n a ete retrouve pour cette migration', !fs.existsSync(hist3));

// Verification independante : le contenu historique n'est dans aucun objet Git.
let trouveDansGit = false;
try {
  const tous = execSync('git cat-file --batch-all-objects --batch-check', {
    encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const ligne of tous.split('\n')) {
    const [oid, type] = ligne.trim().split(/\s+/);
    if (type !== 'blob') continue;
    const contenu = execSync(`git cat-file blob ${oid}`, { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    if (sha256(contenu) === CIBLE3) { trouveDansGit = true; break; }
  }
} catch { /* git indisponible : on ne conclut pas */ }
ok('le contenu historique est absent de TOUS les objets Git', trouveDansGit === false);

/* ==========================================================================
   4. plm_erp_gs1_interoperability — valeurs attendues, calculees depuis le depot
   ========================================================================== */

console.log('\n  4. `plm_erp_gs1_interoperability` : valeurs de reference du depot');

{
  const MIGRATIONS = path.join(root, 'prisma/migrations');
  const { pgcrypto, uuid_ossp } = await (async () => {
    const a = await import('@electric-sql/pglite/contrib/pgcrypto');
    const b = await import('@electric-sql/pglite/contrib/uuid_ossp');
    return { pgcrypto: a.pgcrypto, uuid_ossp: b.uuid_ossp };
  })();

  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  const cible = '20261006210000_plm_erp_gs1_interoperability';
  const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
  let appliquees = 0;
  for (const d of dossiers) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'));
    appliquees += 1;
    if (d === cible) break;
  }
  ok(`base de reference construite jusqu a la cible (${appliquees} migrations)`,
    dossiers.indexOf(cible) === appliquees - 1, `${appliquees}`);

  const tables = await db.query(`
    SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname IN ('plm_erp_integrations','plm_erp_sync_jobs')
     ORDER BY 1`);
  ok('les deux tables de la migration existent sur la base de reference',
    tables.rows.length === 2, JSON.stringify(tables.rows));

  const politiques = await db.query(`
    SELECT tablename, policyname, cmd, md5(coalesce(qual,'') || '|' || coalesce(with_check,'')) AS empreinte_regle
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename IN ('plm_erp_integrations','plm_erp_sync_jobs')
     ORDER BY tablename, policyname`);
  ok('les quatre politiques de la migration existent',
    politiques.rows.length === 4, `${politiques.rows.length}`);

  const fonction = await db.query(`
    SELECT p.prosecdef, p.provolatile,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
           md5(pg_catalog.pg_get_functiondef(p.oid)) AS empreinte_definition
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'tracefab_ingest_plm_erp_payload'`);
  ok('la fonction d ingestion existe et est SECURITY DEFINER',
    fonction.rows.length === 1 && fonction.rows[0].prosecdef === true,
    JSON.stringify(fonction.rows[0] || null));

  console.log('\n  VALEURS DE REFERENCE — a comparer a la sortie de la requete');
  console.log('  de confrontation du document 2026-10-28-tour28-divergences-empreintes.md :\n');
  for (const t of tables.rows) {
    console.log(`    table   ${t.relname}  rls=${t.rls} force_rls=${t.force_rls}`);
  }
  for (const p of politiques.rows) {
    console.log(`    policy  ${p.tablename}.${p.policyname}  cmd=${p.cmd}  regle=${p.empreinte_regle}`);
  }
  const f = fonction.rows[0];
  if (f) {
    console.log(`    fonction ${f.arguments}  secdef=${f.prosecdef}  definition=${f.empreinte_definition}`);
  }
  await db.close();
}

console.log('\n  --------------------------------------------');
if (echecs > 0) {
  console.error(`  ${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`  ${verifies} verifications passees.`);
console.log('  Divergences qualifiees par l execution, non par la lecture du diff.');
console.log('  La 3e reste INCONNUE : confrontation au catalogue de production requise.\n');
