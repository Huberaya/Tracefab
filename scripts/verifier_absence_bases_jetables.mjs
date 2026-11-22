#!/usr/bin/env node
/**
 * Preuve d'absence — aucune base jetable ne subsiste après une suite (P10.2).
 *
 * POURQUOI CE SCRIPT
 *
 * « Le nettoyage a tourné » n'est pas une preuve ; « il ne reste rien » en est
 * une. Ce contrôle est volontairement SÉPARÉ des suites qu'il contrôle : une
 * suite qui oublie de se ranger ne peut pas se déclarer propre, puisqu'elle ne
 * mesure pas elle-même son résidu.
 *
 * CE QU'IL VÉRIFIE
 *
 * Toute base dont le nom commence par `tf_` est un résidu, sauf celles de la
 * liste `CONSERVEES` ci-dessous — qui sont nommées explicitement, jamais
 * déduites d'un motif.
 *
 * CE QU'IL NE FAIT PAS
 *
 *   — il ne détruit RIEN. Un contrôle qui nettoie ce qu'il mesure masquerait
 *     le défaut qu'on cherche à voir ;
 *   — il ne se fie pas au manifeste : le résidu qu'on cherche est précisément
 *     celui qui n'y figure pas.
 *
 * PRÉREQUIS : DATABASE_URL, cible classée jetable (garde de cible à l'import).
 *
 * USAGE
 *   node scripts/verifier_absence_bases_jetables.mjs
 *   node scripts/verifier_absence_bases_jetables.mjs --attendu tracefab_test
 *
 * Sorties : 0 aucune base jetable résiduelle · 1 au moins un résidu · 2/prérefus
 * de cible (aucune connexion métier).
 */
import './lib/garde_import.mjs';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { deriverUrl } from './lib/ephemeral-db.mjs';

/**
 * Bases `tf_*` légitimement présentes en fin de suite.
 *
 * Volontairement VIDE : aucune base `tf_*` ne doit survivre à un job. Si une
 * installation devait en conserver une, elle serait nommée ici — la liste est
 * une décision, pas un motif.
 */
const CONSERVEES = new Set([]);

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--attendu' && argv[i + 1]) CONSERVEES.add(argv[i + 1]);
}

const urlMaintenance = deriverUrl(process.env.DATABASE_URL, 'postgres');
const client = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await client.connect();

try {
  const { rows } = await client.query(
    "SELECT datname FROM pg_database WHERE datname LIKE 'tf\\_%' ORDER BY 1",
  );
  const residus = rows.map((r) => r.datname).filter((n) => !CONSERVEES.has(n));
  if (residus.length === 0) {
    console.log('  ok — aucune base jetable residuelle (tf_*).');
    process.exit(0);
  }
  console.error(`  ECHEC — ${residus.length} base(s) jetable(s) residuelle(s) : ${residus.join(', ')}`);
  console.error('  Une base tf_* qui survit a un job est une orpheline : elle n a pas ete reprise.');
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
