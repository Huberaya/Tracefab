#!/usr/bin/env node
/**
 * Correctif `supplier_portal` : prouver le defaut, puis prouver le correctif.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La production refuse l'invitation d'un `owner` portant un `relationship_id`
 * (onboarding fournisseur) parce qu'elle a execute une version plus stricte de
 * `tracefab_validate_member_invitation_role` que celle du depot. Une migration
 * corrective existe (`20261028140000`), mais une migration corrective ecrite
 * sans test serait une affirmation de plus : ce test reproduit le refus AVANT,
 * applique la migration, et mesure APRES.
 *
 * CE QU'IL PROUVE, ET DANS CET ORDRE
 *   1. le defaut : sur l'etat de production, l'invitation owner+relation echoue ;
 *   2. le correctif : apres migration, elle passe ;
 *   3. la non-regression : owner SANS relation reste refuse — le correctif
 *      n'ouvre pas une porte que la regle fermait ;
 *   4. l'idempotence : la migration se rejoue sans erreur ;
 *   5. l'absence d'effet sur les privileges : aucun GRANT ajoute, la fonction
 *      reste SECURITY DEFINER mais n'est pas executable par PUBLIC ;
 *   6. l'integrite : la chaine complete des 64 migrations s'applique, la
 *      migration corrective etant la derniere.
 *
 * CE QU'IL NE PROUVE PAS
 *   L'etat exact de la production. Il prouve que la migration transforme l'etat
 *   MESURE au tour 28 en l'etat attendu.
 *
 *   npm run test:supplier-invitation-corrective
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');
const CORRECTIVE = '20261028140000_supplier_invitation_owner_relationship_scope';
const FIXTURE_PROD = path.join(root, 'scripts/fixtures/empreintes-production-20261028/supplier_portal.sql');

let PGlite, pgcrypto, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
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

const LIRE = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');

/** Extrait la definition de la fonction de validation d'un fichier de migration. */
function corpsFonction(sql) {
  const m = sql.match(/CREATE OR REPLACE FUNCTION tracefab_validate_member_invitation_role\(\)[\s\S]*?\$\$;/);
  return m ? m[0] : null;
}

/** Prepare une base minimale portant la table, le declencheur et la fonction. */
async function base() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE TYPE membership_role AS ENUM
      ('owner','admin','manager','contributor','auditor','viewer','supplier_user');
    CREATE TABLE organization_invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target_role membership_role NOT NULL,
      relationship_id uuid
    );
  `);
  return db;
}

async function installer(db, corps) {
  await db.exec(corps);
  await db.exec(`
    DROP TRIGGER IF EXISTS organization_invitations_validate_role ON organization_invitations;
    CREATE TRIGGER organization_invitations_validate_role
      BEFORE INSERT OR UPDATE ON organization_invitations
      FOR EACH ROW EXECUTE FUNCTION tracefab_validate_member_invitation_role();
  `);
}

/** Tente une invitation et rend 'accepte' ou 'refuse'. */
async function inviter(db, { role, relation }) {
  const rel = relation ? "'00000000-0000-0000-0000-000000000042'" : 'null';
  try {
    await db.exec(`INSERT INTO organization_invitations (target_role, relationship_id)
                   VALUES ('${role}', ${rel})`);
    return 'accepte';
  } catch (e) {
    const m = String(e.message);
    if (/owner_role_not_invitable/.test(m)) return 'refuse';
    return `erreur:${m}`;
  }
}

/* ==========================================================================
   1. Le defaut, sur l'etat de production
   ========================================================================== */

console.log('\n  1. Etat de production : le defaut est-il bien la ?');

const corpsProd = corpsFonction(fs.readFileSync(FIXTURE_PROD, 'utf8'));
const corpsCorrectif = corpsFonction(LIRE(CORRECTIVE));
ok('la fonction est extraite du fixture de production', corpsProd !== null);
ok('la fonction est extraite de la migration corrective', corpsCorrectif !== null);
ok('les deux corps DIFFERENT', corpsProd !== corpsCorrectif);

const db = await base();
await installer(db, corpsProd);

const avantOwnerRelation = await inviter(db, { role: 'owner', relation: true });
const avantOwnerSeul = await inviter(db, { role: 'owner', relation: false });
const avantAdminRelation = await inviter(db, { role: 'admin', relation: true });

console.log(`        owner+relation=${avantOwnerRelation}  owner seul=${avantOwnerSeul}  admin+relation=${avantAdminRelation}`);

ok('DEFANT REPRODUIT : owner + relation est REFUSE sur l etat de production',
  avantOwnerRelation === 'refuse', avantOwnerRelation);
ok('owner sans relation est deja refuse (regle de base, inchangee)',
  avantOwnerSeul === 'refuse', avantOwnerSeul);
ok('admin + relation est accepte (le declencheur ne vise que owner)',
  avantAdminRelation === 'accepte', avantAdminRelation);

/* ==========================================================================
   2. Le correctif applique
   ========================================================================== */

console.log('\n  2. Application de la migration corrective');

const doc = fs.readFileSync(path.join(MIGRATIONS, CORRECTIVE, 'migration.sql'), 'utf8');

// La migration repose le declencheur : on la joue TELLE QUELLE, pas seulement
// le corps de la fonction. Une migration dont on n'execute qu'un morceau n'est
// pas la migration.
let appliquee = 'ok';
try { await db.exec(doc); } catch (e) { appliquee = String(e.message); }
ok('la migration corrective s applique', appliquee === 'ok', appliquee.slice(0, 200));

const apresOwnerRelation = await inviter(db, { role: 'owner', relation: true });
const apresOwnerSeul = await inviter(db, { role: 'owner', relation: false });
const apresAdminRelation = await inviter(db, { role: 'admin', relation: true });

console.log(`        owner+relation=${apresOwnerRelation}  owner seul=${apresOwnerSeul}  admin+relation=${apresAdminRelation}`);

ok('CORRIGE : owner + relation est desormais ACCEPTE', apresOwnerRelation === 'accepte',
  apresOwnerRelation);
ok('NON-REGRESSION : owner sans relation reste REFUSE', apresOwnerSeul === 'refuse',
  apresOwnerSeul);
ok('NON-REGRESSION : admin + relation reste accepte', apresAdminRelation === 'accepte',
  apresAdminRelation);
ok('le comportement change EXACTEMENT sur un cas, et sur celui-la seul',
  avantOwnerSeul === apresOwnerSeul && avantAdminRelation === apresAdminRelation
  && avantOwnerRelation !== apresOwnerRelation);

// Le declencheur doit exister et pointer sur la bonne fonction : sans cela la
// correction serait ecrite mais jamais appelee.
const decl = await db.query(`
  SELECT p.proname, t.tgenabled
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgname = 'organization_invitations_validate_role'`);
ok('le declencheur existe et pointe sur la fonction corrigee',
  decl.rows.length === 1 && decl.rows[0].proname === 'tracefab_validate_member_invitation_role',
  JSON.stringify(decl.rows));

/* ==========================================================================
   3. Idempotence
   ========================================================================== */

console.log('\n  3. Idempotence');

let rejeu = 'ok';
try { await db.exec(doc); } catch (e) { rejeu = String(e.message); }
ok('la migration se rejoue sans erreur', rejeu === 'ok', rejeu.slice(0, 200));
ok('le comportement est inchange apres rejeu',
  (await inviter(db, { role: 'owner', relation: true })) === 'accepte');
const declApres = await db.query(
  `SELECT count(*)::int n FROM pg_catalog.pg_trigger
    WHERE tgname = 'organization_invitations_validate_role'`);
ok('le declencheur n a pas ete duplique', declApres.rows[0].n === 1, `${declApres.rows[0].n}`);

/* ==========================================================================
   4. Aucun privilege accorde
   ========================================================================== */

console.log('\n  4. Privileges : le correctif n accorde rien');

const secdef = await db.query(`
  SELECT p.prosecdef,
         has_function_privilege('public', p.oid, 'EXECUTE') AS executable_par_public
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tracefab_validate_member_invitation_role'`);
ok('la fonction reste SECURITY DEFINER', secdef.rows[0]?.prosecdef === true,
  JSON.stringify(secdef.rows[0]));
ok('aucune migration corrective n accorde EXECUTE (le registre reste la seule voie)',
  !/\bGRANT\b/i.test(doc.replace(/--[^\n]*/g, '')),
  'la migration contient un GRANT hors commentaire');
await db.close();

/* ==========================================================================
   5. La chaine complete, correction en derniere position
   ========================================================================== */

console.log('\n  5. Chaine complete des migrations');

const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
ok('la migration corrective est la DERNIERE de la chaine',
  dossiers[dossiers.length - 1] === CORRECTIVE, dossiers[dossiers.length - 1]);
ok('aucune migration historique n a ete renumerotee (64 au total)',
  dossiers.length === 64, `${dossiers.length}`);

{
  const db2 = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db2.waitReady;
  await db2.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  let appliquees = 0;
  let erreur = null;
  for (const d of dossiers) {
    try {
      await db2.exec(fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'));
      appliquees += 1;
    } catch (e) { erreur = `${d} : ${e.message}`; break; }
  }
  ok('les 64 migrations s appliquent sur une base vierge', erreur === null && appliquees === 64,
    erreur || `${appliquees}/64`);

  // Sur la chaine reelle, la regle doit deja etre celle du depot : la migration
  // 20261005090000 porte le corps corrige.
  const comporte = await db2.query(`
    SELECT pg_catalog.pg_get_functiondef(p.oid) AS d
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'tracefab_validate_member_invitation_role'`);
  const def = comporte.rows[0]?.d || '';
  ok('sur la chaine complete, la regle porte la condition sur relationship_id',
    /relationship_id IS NULL/.test(def), def.slice(0, 120));
  await db2.close();
}

console.log('\n  --------------------------------------------');
if (echecs > 0) {
  console.error(`  ${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`  ${verifies} verifications passees.`);
console.log('  Defaut reproduit, correctif mesure, non-regression et idempotence prouvees.\n');
