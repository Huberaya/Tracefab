#!/usr/bin/env node
/**
 * Lire l'identité PostgreSQL effective du runtime.
 *
 * Exécute scripts/verifier-role-runtime.sql contre la base de DATABASE_URL et
 * n'affiche que des noms de rôles, des booléens et un compte de lignes. La
 * chaîne de connexion n'est jamais affichée, ni en entier ni en partie : seul
 * l'hôte est repris, parce qu'il faut pouvoir confirmer à voix haute que la
 * requête part vers la branche attendue et non vers une autre.
 *
 * STRICTEMENT EN LECTURE SEULE : ce script n'ouvre aucune transaction
 * d'écriture, ne crée rien, ne modifie aucun privilège, n'exécute aucune
 * migration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('  NON EXECUTE — DATABASE_URL est absente.');
  console.error("  Renseignez-la, puis relancez : npm run db:role-runtime");
  process.exit(2);
}

const champ = (re) => (url.match(re) || [])[1] ?? 'illisible';
const hote = champ(/@([^/:]+)/);
const base = champ(/\/([^/?]+)(\?|$)/);

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sql = fs.readFileSync(path.join(racine, 'scripts', 'verifier-role-runtime.sql'), 'utf8');

console.log('');
console.log('  Identité PostgreSQL du runtime — lecture seule');
console.log('');
console.log(`  hote verifie : ${hote}`);
console.log(`  base         : ${base}`);
console.log('  Confirmez que cet hôte est bien celui de la branche visée avant de');
console.log('  poursuivre : c est le seul moyen de savoir quelle base répond.');
console.log('');

const c = new pg.Client({ connectionString: url });
await c.connect();

try {
  const r = await c.query(sql);

  const identite = r[0].rows[0];
  console.log(`  role_de_connexion  : ${identite.role_de_connexion}`);
  console.log(`  role_de_session    : ${identite.role_de_session}`);
  console.log(`  est_superuser      : ${identite.est_superuser}`);
  console.log(`  contourne_rls      : ${identite.contourne_rls}`);
  console.log('');

  const visibles = r[1].rows[0].lignes_visibles_sans_contexte;
  console.log(`  lignes visibles sans contexte : ${visibles}`);
  console.log('');

  console.log('  roles candidats :');
  for (const x of r[2].rows) {
    console.log(
      `    ${x.rolname.padEnd(15)} superuser=${String(x.rolsuper).padEnd(5)} bypassrls=${String(x.rolbypassrls).padEnd(5)} login=${x.rolcanlogin}`,
    );
  }
  console.log('');

  // Le verdict ne se déduit pas des propriétés déclarées : il se mesure.
  if (identite.contourne_rls || Number(visibles) > 0) {
    console.log('  VERDICT : ce role CONTOURNE la RLS. Les politiques ne sont jamais');
    console.log('  evaluees pour lui, et l isolation inter-organisations ne repose pas');
    console.log('  sur la base. C est le role de migration, pas un role de runtime.');
  } else {
    console.log('  VERDICT : ce role est soumis a la RLS. Sans contexte arme il ne voit');
    console.log('  aucune ligne : les politiques sont bien evaluees sur ce chemin.');
  }
} finally {
  await c.end();
}

console.log('');
process.exit(0);
