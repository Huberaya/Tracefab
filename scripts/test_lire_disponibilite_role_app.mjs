#!/usr/bin/env node
/**
 * Non-regression du rapport d'ecarts de scripts/lire-disponibilite-role-app.mjs.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Ce script de diagnostic classait l'absence d'ecriture a partir d'un jeu de
 * quatre noms de tables ecrit en dur. Depuis que la politique d'ecriture est
 * passee de 4 a 21 tables (migration 20261019160000), il presentait 25 tables
 * volontairement en lecture seule comme « autre(s) », c'est-a-dire inexpliquees.
 * Un operateur charge d'auditer une base distante aurait donc eu 25 signaux a
 * classer alors qu'il n'y en avait aucun.
 *
 * Le script compare desormais l'etat MESURE a TABLES_ECRITURE_DIRECTE, la liste
 * unique deja utilisee par le provisioning et par test:tables-ecriture-directe,
 * et nomme les deux sortes d'ecarts : DML accorde hors liste (sur-privilege) et
 * table declaree sans DML (sous-privilege ou cible en retard de migrations).
 *
 * Test statique : aucune base, aucun reseau. Le comportement reel est eprouve
 * par scripts/test_ecarts_privileges_role_app.mjs sur base jetable.
 *
 * Sortie : 0 = toutes les assertions vertes, 1 = au moins un echec.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = resolve(ICI, '..');
const CHEMIN = resolve(ICI, 'lire-disponibilite-role-app.mjs');
const LIB = resolve(ICI, 'lib', 'tracefab_app_role.mjs');

const source = readFileSync(CHEMIN, 'utf8');
const libSource = readFileSync(LIB, 'utf8');

let vertes = 0;
const echecs = [];
const ok = (message) => { vertes++; console.log(`  ok    ${message}`); };
const ko = (message) => { echecs.push(message); console.log(`  ECHEC ${message}`); };
const verifier = (condition, message) => (condition ? ok(message) : ko(message));

console.log('');
console.log('  Rapport d\'ecarts de privileges — non-regression statique');
console.log('  --------------------------------------------');

// 1. La liste comparee est celle du depot, pas une copie locale.
verifier(
  /from\s+'\.\/lib\/tracefab_app_role\.mjs'/.test(source),
  'le script importe la source unique scripts/lib/tracefab_app_role.mjs',
);
verifier(
  /import\s*\{[^}]*\bTABLES_ECRITURE_DIRECTE\b[^}]*\}/.test(source),
  'il importe TABLES_ECRITURE_DIRECTE',
);
verifier(
  /import\s*\{[^}]*\bAPP_ROLE\b[^}]*\}/.test(source),
  'il importe APP_ROLE',
);
verifier(
  /TABLES_ECRITURE_DIRECTE/.test(libSource) && /export const TABLES_ECRITURE_DIRECTE/.test(libSource),
  'la liste est bien exportee par la lib (pas une duplication)',
);

// 2. Aucun jeu de tables ecrit en dur ne subsiste pour la classification.
verifier(
  !/APPEND_ONLY/.test(source),
  'le jeu de noms APPEND_ONLY ecrit en dur a disparu',
);
const listesEnDur = source.match(/new Set\(\[\s*'[a-z_]+'/g) || [];
verifier(
  listesEnDur.length === 0,
  'aucune liste de noms de tables n\'est reconstruite en dur dans le script',
);
verifier(
  /process\.env\.TF_CIBLE_ROLE \|\| APP_ROLE/.test(source),
  'le role cible par defaut vient de APP_ROLE, pas d\'une litterale',
);

// 3. Les deux sens d'ecart sont nommes : sans eux, un sur-privilege passe.
verifier(
  /hors liste declaree/.test(source),
  'le sur-privilege (DML accorde hors liste declaree) est nomme',
);
verifier(
  /de la liste declaree sans DML/.test(source),
  'le sous-privilege (table declaree sans DML) est nomme',
);
verifier(
  /absente\(s\) de la cible/.test(source),
  'une table declaree mais absente de la cible est signalee',
);
verifier(
  /inattendue\(s\)/.test(source),
  'l\'absence de DML est distinguee entre attendue et inattendue',
);

// 3b. La sonde d'identité suit la même allowlist que les migrations.
verifier(
  /import\s*\{[^}]*\bRUNTIME_FUNCTION_NAMES\b[^}]*\}\s*from\s*'\.\/lib\/tracefab_runtime_functions\.mjs'/.test(source),
  'le rapport importe la même allowlist de fonctions runtime que la migration',
);
verifier(
  /p\.proname\s*=\s*ANY\(\$1::text\[\]\)/.test(source),
  'EXECUTE est vérifié sur les fonctions explicitement autorisées',
);
verifier(
  /p\.prosecdef\s*=\s*true\s+AND\s+p\.proname\s*<>\s*ALL\(\$1::text\[\]\)/.test(source),
  'les fonctions SECURITY DEFINER hors allowlist sont contrôlées séparément',
);

// 4. Un ecart ne doit pas se confondre avec un obstacle.
verifier(
  /let ecarts = 0;/.test(source) && /ecarts\+\+/.test(source),
  'les ecarts sont comptes separement des obstacles',
);
verifier(
  /obstacles === 0 && ecarts === 0/.test(source),
  'le verdict « pret » exige zero obstacle ET zero ecart',
);
verifier(
  /process\.exit\(obstacles === 0 \? 0 : 1\)/.test(source),
  'le code de sortie reste pilote par les obstacles seuls (un ecart ne bloque pas)',
);
verifier(
  /OBSTACLE : SELECT absent/.test(source),
  'l\'absence de SELECT reste un obstacle',
);

// 5. Le script reste strictement en lecture seule et ne fuit rien.
// Seuls les commentaires sont ecartes. Les litterales NE le sont PAS : c'est
// justement dans une litterale que passerait un `client.query('GRANT …')`.
// Le motif vise donc des INSTRUCTIONS SQL completes, pas des mots isoles : le
// script tient des compteurs nommes INSERT/UPDATE/DELETE et interroge
// has_table_privilege(role, table, 'INSERT'), qui nomment un privilege sans
// rien ecrire. `GRANT …`, `INSERT INTO …` et `DELETE FROM …` ecrivent.
const horsCommentaires = source
  .split('\n')
  .filter((ligne) => !/^\s*(\*|\/\/)/.test(ligne))
  .join('\n');
const INSTRUCTIONS_D_ECRITURE = [
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+[^\s]+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bCREATE\s+(TABLE|ROLE|INDEX|SCHEMA|FUNCTION|POLICY|TRIGGER|OR)\b/i,
  /\bDROP\s+(TABLE|ROLE|INDEX|SCHEMA|FUNCTION|POLICY|TRIGGER|DATABASE|OWNED)\b/i,
  /\bALTER\s+(TABLE|ROLE|SCHEMA|FUNCTION|POLICY|DATABASE|DEFAULT)\b/i,
  /\bGRANT\s+/i,
  /\bREVOKE\s+/i,
  /\bTRUNCATE\b/i,
  /\bCOPY\s+[^\s]+\s+FROM\b/i,
];
const instructionsTrouvees = INSTRUCTIONS_D_ECRITURE.filter((motif) => motif.test(horsCommentaires));
verifier(
  instructionsTrouvees.length === 0,
  'aucune instruction d\'ecriture executee (INSERT INTO, GRANT, ALTER, …)',
);
verifier(
  !/\bBEGIN\b/.test(horsCommentaires) && !/SET TRANSACTION/i.test(horsCommentaires),
  'aucune transaction ouverte ni mode ecriture',
);
verifier(
  /hote verifie/.test(source),
  'l\'hote est affiche avant toute connexion utile',
);
verifier(
  !/console\.(log|error)\([^)]*\burl\b/.test(source),
  'la chaine de connexion n\'est jamais affichee',
);

// 6. Le fichier doit rester executable.
try {
  execFileSync(process.execPath, ['--check', CHEMIN], { cwd: RACINE, stdio: 'pipe' });
  ok('le script passe node --check');
} catch (erreur) {
  ko(`node --check echoue : ${String(erreur.stderr || erreur.message).split('\n')[0]}`);
}

const total = vertes + echecs.length;
console.log('  --------------------------------------------');
if (echecs.length === 0) {
  console.log(`  ${vertes}/${total} assertions vertes`);
  console.log('  ok — le rapport d\'ecarts compare a la liste declaree, pas a un jeu fige.');
  console.log('');
  process.exit(0);
}
console.log(`  ${vertes}/${total} assertions vertes, ${echecs.length} echec(s).`);
console.log('');
process.exit(1);
