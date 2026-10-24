#!/usr/bin/env tsx
/**
 * Preuve, par execution, que l'instrument d'identite du runtime mesure bien le
 * role de la connexion et discrimine un role permissif d'un role conforme.
 *
 * POURQUOI CE TEST EXISTE
 *
 *   La sonde `probeDatabaseIdentity()` est le seul instrument capable de dire
 *   quel role PostgreSQL sert reellement les requetes : elle lit `current_user`
 *   sur la connexion du MEME client Prisma que les routes metier. Un
 *   instrument qui n'est jamais eprouve ne prouve rien — il peut renvoyer
 *   « conforme » par construction. Ce test l'eprouve dans les DEUX SENS, sur
 *   une base reelle :
 *
 *     A. branche sous `tracefab_app` : le role est mesure, il n'a ni
 *        SUPERUSER, ni BYPASSRLS, ni appartenance privilegiee, et la RLS le
 *        soumet — il ne voit AUCUNE ligne sans contexte arme ;
 *     B. controle NEGATIF sous le proprietaire : les memes donnees SONT
 *        visibles. Sans ce temoin, un « 0 ligne » pourrait venir d'une table
 *        vide, et ne prouverait rien de la RLS.
 *
 * CE QU'IL N'EST PAS
 *   Il ne mesure PAS la Preview : un test de CI ne joint aucune Preview. La
 *   mesure du runtime de Preview appartient a
 *   `scripts/probe_preview_runtime_identity.mjs`, execute par le workflow
 *   authentifie. Ce test-ci prouve l'instrument ; l'autre prouve le terrain.
 *
 * GARDE DE CIBLE
 *   Reutilise `scripts/lib/require-throwaway-db.mjs` : toute cible non
 *   localement jetable est refusee avant la moindre connexion. Aucune chaine
 *   de connexion n'est affichee.
 */
import pg from 'pg';
import { assertThrowawayDb } from './lib/require-throwaway-db.mjs';
import {
  databaseIdentityIsSafe,
  databaseIdentityViolations,
  probeDatabaseIdentity,
} from '../api/_lib/readiness-probes.js';

const OWNER_URL = (process.env.TF_OWNER_URL || '').trim();

// Garde AVANT tout import de connexion : le client Prisma se construit au
// chargement du module, donc la cible doit deja etre classee.
assertThrowawayDb({ variables: ['DATABASE_URL'], purpose: 'identite runtime — instrument' });
if (!OWNER_URL) {
  console.error('\n  NON EXECUTE — TF_OWNER_URL absente (controle negatif impossible).');
  console.error('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.\n');
  process.exit(2);
}
assertThrowawayDb({ variables: ['TF_OWNER_URL'], purpose: 'identite runtime — controle negatif' });

let echecs = 0;
function verifier(condition: boolean, libelle: string, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${libelle}`);
  } else {
    echecs += 1;
    console.log(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n  --- A. la sonde mesure le role de la connexion runtime');

const identite = await probeDatabaseIdentity();

verifier(identite.measured === true, 'la sonde a mesure une identite', identite.detail);
verifier(identite.currentUser === 'tracefab_app', 'current_user est le role applicatif', String(identite.currentUser));
verifier(identite.sessionUser === 'tracefab_app', 'session_user egale current_user (aucun SET ROLE)', String(identite.sessionUser));
verifier(identite.currentUser === identite.sessionUser, 'les deux roles ne divergent pas : aucun SET ROLE dans le chemin');
verifier(identite.bypassesRls === false, 'rolbypassrls = false', String(identite.bypassesRls));
verifier(identite.isSuperuser === false, 'rolsuper = false', String(identite.isSuperuser));
verifier(identite.canCreateDb === false, 'rolcreatedb = false', String(identite.canCreateDb));
verifier(identite.canCreateRole === false, 'rolcreaterole = false', String(identite.canCreateRole));
verifier(identite.canReplicate === false, 'rolreplication = false', String(identite.canReplicate));
verifier(identite.privilegedMemberships === 0, 'aucune appartenance a un role privilegie', String(identite.privilegedMemberships));
verifier(identite.rowSecurityGuc === 'on', 'row_security = on', String(identite.rowSecurityGuc));
verifier(identite.rlsEnabledOnProducts === true, 'RLS activee sur tracefab_products', String(identite.rlsEnabledOnProducts));
verifier(identite.ownsProductTable === false, 'le role ne possede pas tracefab_products', String(identite.ownsProductTable));
verifier(identite.canSelectProducts === true, 'le role peut lire les produits (sinon l application serait cassee)', String(identite.canSelectProducts));
verifier(identite.canWriteProducts === false, 'le role n a pas d ecriture directe sur les produits', String(identite.canWriteProducts));

console.log('\n  --- B. la RLS soumet reellement le role applicatif');

const appSansContexte = identite.rowsVisibleWithoutContext;
verifier(appSansContexte === 0, 'sans contexte arme, le role applicatif ne voit aucune ligne', String(appSansContexte));

// Controle negatif : les MEMES donnees doivent etre visibles au proprietaire,
// sinon le « 0 ligne » ci-dessus ne prouve rien (table vide, ou mesure en
// panne). Ce temoin est une simple lecture, puis il est referme.
const proprietaire = new pg.Client({ connectionString: OWNER_URL });
try {
  await proprietaire.connect();
  const { rows } = await proprietaire.query('SELECT count(*)::int AS visible FROM public.tracefab_products');
  const visible = rows[0]?.visible ?? 0;
  const { rows: role } = await proprietaire.query(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  verifier(visible > 0, 'controle negatif : des lignes existent et sont visibles au proprietaire', `visible=${visible}`);
  verifier(
    role[0]?.rolbypassrls === true || role[0]?.rolsuper === true,
    'controle negatif : le proprietaire contourne effectivement la RLS (sinon le temoin ne discrimine pas)',
  );
} finally {
  await proprietaire.end().catch(() => {});
}

console.log('\n  --- C. le verdict est coherent avec les mesures');

verifier(databaseIdentityViolations(identite).length === 0, 'aucune violation sur une cible conforme', databaseIdentityViolations(identite).join('|'));
verifier(databaseIdentityIsSafe(identite) === true, 'le contrat de securite est satisfait par ce role');
verifier(
  databaseIdentityIsSafe({ ...identite, bypassesRls: true, privilegedMemberships: 0 }) === false,
  'le contrat REFUSE un role porteur de BYPASSRLS',
);
verifier(
  databaseIdentityIsSafe({ ...identite, currentUser: 'neondb_owner', sessionUser: 'neondb_owner' }) === false,
  'le contrat REFUSE un role proprietaire a la place du role applicatif',
);
verifier(
  databaseIdentityIsSafe({ ...identite, rowsVisibleWithoutContext: 1 }) === false,
  'le contrat REFUSE un role qui voit des lignes sans contexte',
);
verifier(
  databaseIdentityIsSafe({ ...identite, privilegedMemberships: 1, privilegedMembershipNames: ['role_privilegie'] }) === false,
  'le contrat REFUSE une appartenance indirecte a un role privilegie',
);

console.log(`\n  Instrument d'identite runtime : ${echecs === 0 ? 'OK' : `${echecs} echec(s)`}.\n`);
console.log(`::notice title=P1 identite runtime — instrument::controles=${echecs === 0 ? 'PASS' : 'FAIL'} `
  + `role=${identite.currentUser ?? 'inconnu'} bypassrls=${identite.bypassesRls} superuser=${identite.isSuperuser} `
  + `lignes_sans_contexte=${identite.rowsVisibleWithoutContext}`);
process.exit(echecs === 0 ? 0 : 1);
