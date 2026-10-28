#!/usr/bin/env node
/**
 * Le runbook d'application (fichier B) doit etre executable ET discriminant.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `docs/security/2026-10-28-tour30-B-application-correctif.sql` sera lance en
 * production par un operateur. Deux facons de se tromper :
 *
 *   1. un SQL qui ne passe pas — et l'operateur le decouvre au pire moment ;
 *   2. des sondes qui « passent » partout : elles n'ecriraient aucune ligne dans
 *      un cas comme dans l'autre et ne prouveraient donc rien.
 *
 * Ce test mesure les deux. Il rejoue le bloc de sondes tel qu'il est ecrit dans
 * le document — pas une copie — sur la chaine complete, sans puis avec le
 * correctif, et exige un resultat DIFFERENT :
 *
 *   sans correctif : la relation terminee accepte son invitation   -> 2 lignes
 *   avec correctif  : elle est refusee                             -> 1 ligne
 *
 * La ligne restante est la sonde (d) — `admin` + relation — qui doit rester
 * acceptee dans les deux cas : c'est la non-regression.
 *
 * Aucune connexion, aucun secret. Tout est annule par ROLLBACK.
 *
 *   npm run test:runbook-application
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');
const RUNBOOK = path.join(root, 'docs/security/2026-10-28-tour30-B-application-correctif.sql');
const CORRECTIVE = '20261028140000_supplier_invitation_owner_relationship_scope';

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

const doc = fs.readFileSync(RUNBOOK, 'utf8');
const debut = doc.indexOf('DO $sondes$');
const fin = doc.indexOf('$sondes$;') + '$sondes$;'.length;
const bloc = doc.slice(debut, fin);
ok('le document contient un bloc de sondes identifiable', debut > 0 && fin > debut, `${bloc.length} caracteres`);
ok('les cinq sondes sont presentes',
  ['SONDE (a)', 'SONDE (b)', 'SONDE (c)', 'SONDE (d)', 'SONDE (e)']
    .every((s) => doc.includes(s)));

const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const LIRE = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');

const MARQUE = 'eeeeeeee-0000-0000-0000-000000000001';
const FOURN_A = 'eeeeeeee-0000-0000-0000-000000000002';
const FOURN_B = 'eeeeeeee-0000-0000-0000-000000000003';

async function base({ avecCorrective }) {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  for (const d of dossiers) {
    if (d === CORRECTIVE && !avecCorrective) continue;
    await db.exec(LIRE(d));
  }
  // Deux couples distincts : la contrainte d unicite interdit deux relations
  // entre les memes organisations, et la relation terminee doit exister pour
  // que la sonde (e) soit jouee.
  await db.exec(`
    INSERT INTO organizations (id, type, legal_name) VALUES
      ('${MARQUE}', 'brand', 'Marque E'),
      ('${FOURN_A}', 'supplier', 'Fournisseur E1'),
      ('${FOURN_B}', 'supplier', 'Fournisseur E2');
    INSERT INTO users (id, clerk_user_id, email, full_name) VALUES
      ('eeeeeeee-0000-0000-0000-000000000009', 'clerk-runbook', 'runbook@exemple.invalid', 'Runbook');
    INSERT INTO brand_supplier_relationships (brand_organization_id, supplier_organization_id, status) VALUES
      ('${MARQUE}', '${FOURN_A}', 'active'),
      ('${MARQUE}', '${FOURN_B}', 'ended');
  `);
  return db;
}

async function jouer({ avecCorrective }) {
  const db = await base({ avecCorrective });
  await db.exec('BEGIN');
  let erreur = null;
  try { await db.exec(bloc); } catch (e) { erreur = `${e.code} ${e.message}`; }
  const dedans = (await db.query('SELECT count(*)::int n FROM organization_invitations')).rows[0].n;
  await db.exec('ROLLBACK');
  const apres = (await db.query('SELECT count(*)::int n FROM organization_invitations')).rows[0].n;
  await db.close();
  return { erreur, dedans, apres };
}

console.log('\n  1. Le bloc de sondes s execute sur la chaine sans correctif');
const avant = await jouer({ avecCorrective: false });
ok('aucune erreur SQL', avant.erreur === null, avant.erreur || '');
ok('deux invitations passent : `admin` (d) et relation terminee (e)',
  avant.dedans === 2, `${avant.dedans} ligne(s)`);
ok('le ROLLBACK ne laisse rien', avant.apres === 0, `${avant.apres}`);

console.log('\n  2. Le bloc de sondes s execute sur la chaine avec le correctif');
const apresC = await jouer({ avecCorrective: true });
ok('aucune erreur SQL', apresC.erreur === null, apresC.erreur || '');
ok('une seule invitation passe : `admin` (d) — la relation terminee est refusee',
  apresC.dedans === 1, `${apresC.dedans} ligne(s)`);
ok('le ROLLBACK ne laisse rien', apresC.apres === 0, `${apresC.apres}`);

console.log('\n  3. Les sondes discriminent');
ok('le resultat DIFFERE entre avant et apres : les sondes prouvent quelque chose',
  avant.dedans === 2 && apresC.dedans === 1, `${avant.dedans} contre ${apresC.dedans}`);
ok('la non-regression `admin` est verifiee dans les deux etats (au moins une ligne passe toujours)',
  avant.dedans >= 1 && apresC.dedans >= 1);

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  Le runbook s execute, et ses sondes distinguent les deux etats.\n');
  process.exit(0);
}
console.log(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
