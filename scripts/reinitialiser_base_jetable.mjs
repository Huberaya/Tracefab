#!/usr/bin/env node
/**
 * Remise a zero de la base de test fixe (`tracefab_test`), par la garde.
 *
 * Remplace, dans les scripts shell d'integration :
 *
 *     psql -d postgres -c "DROP DATABASE IF EXISTS tracefab_test;"
 *     psql -d postgres -c "CREATE DATABASE tracefab_test OWNER postgres;"
 *
 * ou le `DROP` precedent tout controle : une base `tracefab_test` preexistante
 * et remplie etait detruite sans preuve qu'elle etait jetable.
 *
 * Usage :
 *   node scripts/run-db-suite.mjs scripts/reinitialiser_base_jetable.mjs
 *   node scripts/reinitialiser_base_jetable.mjs [--base tracefab_test]
 *
 * Variables :
 *   DATABASE_URL   connexion jetable (obligatoire, reclassifiee ici)
 *   TF_RESET_BASE  nom alternatif, reserve aux `tf_*` (tests)
 *
 * Sorties : 0 base prete · 1 echec inattendu · 2 refus (base conservee).
 */
import {
  BaseJetableRefusee,
  EXIT_REFUS,
  MARQUE,
  reinitialiserBaseJetable,
} from './lib/base_jetable.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

const argv = process.argv.slice(2);
let nom = process.env.TF_RESET_BASE || 'tracefab_test';
const iBase = argv.indexOf('--base');
if (iBase !== -1) {
  if (!argv[iBase + 1]) {
    console.error('  REFUS — --base attend un nom.');
    process.exit(EXIT_REFUS);
  }
  nom = argv[iBase + 1];
}

const urlProprietaire = (process.env.DATABASE_URL || '').trim();
if (!urlProprietaire) {
  console.error('  REFUS — DATABASE_URL absent : la remise a zero a besoin d une cible classee.');
  process.exit(EXIT_REFUS);
}

try {
  // La garde de cible est appliquee ICI, pas seulement dans l'appelant : un
  // script shell qui exporterait une URL distante est refuse meme s'il a oublie
  // son propre preflight.
  requireThrowawayDb({
    variables: ['DATABASE_URL'],
    purpose: `remise a zero de ${nom}`,
    exitOnFailure: true,
  });
  const resultat = await reinitialiserBaseJetable({ urlProprietaire, nom });
  const avant = resultat.oidAvant === null ? 'absente' : `oid=${resultat.oidAvant}`;
  console.log(`  base ${resultat.nom} ${resultat.action} (${avant} → oid=${resultat.oidApres},`
    + ` nature=${resultat.adoption}, marque=${MARQUE})`);
  process.exit(0);
} catch (e) {
  if (e instanceof BaseJetableRefusee || e.exitCode === EXIT_REFUS) {
    console.error(`  REFUS — ${e.message}`);
    process.exit(EXIT_REFUS);
  }
  console.error(`  ECHEC — ${e.code ?? ''} ${String(e.message).split('\n')[0]}`);
  process.exit(1);
}
