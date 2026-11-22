#!/usr/bin/env node
/**
 * LE ROLE D'ENTREE EST-IL RETABLI, ET PAR QUOI ?
 *
 * LE DEFAUT MESURE — 2026-11-12, PostgreSQL 17.6 jetable
 *
 * `prisma/migrations/20261028120050_neon_worker_function_grants` revient de
 * `tracefab_worker` par `RESET ROLE`. Dans un runner qui etablit l'identite de
 * migration par `SET LOCAL ROLE tracefab_migrator` — c'est le protocole de
 * `scripts/migrer_fidelement.mjs`, et c'est celui de la CI — `RESET ROLE` ne
 * revient PAS au role de l'appelant : il retablit l'utilisateur de SESSION.
 * Mesure, topologie CI (session `tracefab_ci_admin`) :
 *
 *     runner                        current_user = tracefab_migrator, registre = 84
 *     SET ROLE tracefab_worker      current_user = tracefab_worker
 *     RESET ROLE                    current_user = tracefab_ci_admin, registre = 0
 *
 * Le registre runtime est en FORCE RLS avec une politique
 * `current_user = proprietaire` : cette identite ne voit AUCUNE ligne. La
 * fonction `tracefab_apply_runtime_function_grants()` conclut alors que les 84
 * noms enregistres sont « hors registre », REVOQUE leurs droits, et la 61e
 * migration echoue sur un message de 84 lignes.
 *
 * CE QUE CE FICHIER MESURE
 *
 *   A. Aucun fichier de migration n'utilise `RESET ROLE` (hors commentaire).
 *      La forme correcte est `SET LOCAL ROLE <role d'entree>` : sa restauration
 *      est exacte, et verifiee dans les deux sens.
 *
 *   B. `tracefab_apply_runtime_function_grants()` capture l'identite d'entree
 *      AVANT tout changement d'identite, ne revient que par cette valeur, et
 *      refuse de rendre la main si l'identite n'est pas retablie.
 *
 *   C. CONTROLE NEGATIF — les trois regles mordues. Un detecteur qui n'a jamais
 *      rien attrape ne mesure rien : on lui presente un fichier qui reintroduit
 *      `RESET ROLE`, une fonction qui ne capture pas l'identite, et une fonction
 *      qui ne la controle pas. Chaque cas doit etre signale.
 *
 * Hors ligne : lit des fichiers SQL. Sortie : 0 conforme · 1 defaut.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOSSIER = join(RACINE, 'prisma', 'migrations');
const FICHIER_FONCTION = '20261028120050_neon_worker_function_grants';

let vertes = 0;
let rouges = 0;
const echecs = [];
function verifier(etiquette, ok, detail) {
  if (ok) {
    vertes += 1;
    console.log(`  ok    ${etiquette}`);
  } else {
    rouges += 1;
    echecs.push(etiquette);
    console.log(`  ECHEC ${etiquette}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/**
 * SQL utile : les commentaires `--` sont retires.
 *
 * Pourquoi c'est necessaire ici : le defaut, sa mesure et sa correction sont
 * documentes EN TETE du fichier, en citant `RESET ROLE`. Un detecteur qui lit
 * les commentaires signalerait la documentation du correctif comme une
 * regression, et la seule facon de le faire taire serait de supprimer
 * l'explication. On mesure donc le SQL, jamais la prose.
 */
function sqlUtile(source) {
  return source
    .split('\n')
    .map((ligne) => ligne.replace(/(^|\s)--.*$/, ' '))
    .join('\n');
}

/** Toutes les commandes `RESET ROLE` d'un texte SQL (hors commentaires). */
function occurrencesResetRole(source) {
  return [...sqlUtile(source).matchAll(/\bRESET\s+ROLE\b/gi)].length;
}

/* --- A. Aucune migration ne revient par RESET ROLE ------------------------ */

console.log('\n  A. aucune migration ne retablit le role par RESET ROLE');
{
  const fichiers = readdirSync(DOSSIER, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(DOSSIER, d.name, 'migration.sql'));
  const coupables = fichiers.filter((f) => occurrencesResetRole(readFileSync(f, 'utf8')) > 0);
  verifier('les migrations du depot sont inspectees', fichiers.length >= 90, `${fichiers.length} fichier(s)`);
  verifier('aucune migration n utilise RESET ROLE (hors commentaire)',
    coupables.length === 0,
    coupables.map((f) => f.split('/').slice(-2)[0]).join(', ') || undefined);
}

/* --- B. La fonction porte les trois proprietes ---------------------------- */

console.log('\n  B. la fonction de reconstruction capture, retablit et verifie l identite');
const sourceFonction = readFileSync(join(DOSSIER, FICHIER_FONCTION, 'migration.sql'), 'utf8');
const corps = sqlUtile(sourceFonction);

verifier('la fonction capture `current_user` dans une variable dediee',
  /role_entree\s+TEXT\s*:=\s*current_user/i.test(corps), 'aucune capture de l identite d entree');
verifier('la capture precede tout changement d identite',
  corps.search(/role_entree\s+TEXT\s*:=\s*current_user/i) < corps.search(/\bSET\s+(LOCAL\s+)?ROLE\s+tracefab_worker\b/i),
  'la capture arrive apres le premier SET ROLE');
verifier('aucun retour par RESET ROLE dans la fonction', occurrencesResetRole(sourceFonction) === 0,
  `${occurrencesResetRole(sourceFonction)} occurrence(s)`);
verifier('les retours se font par `SET LOCAL ROLE <role_entree>`',
  /format\('SET LOCAL ROLE %I',\s*role_entree\)/i.test(corps), 'retour non parametre');
verifier('la fonction refuse de rendre la main si l identite n est pas retablie',
  /IF\s+current_user\s*<>\s*role_entree\s+THEN[\s\S]{0,200}RAISE EXCEPTION/i.test(corps),
  'aucun controle final sur current_user');

/* --- C. Controle negatif : les trois regles mordent ----------------------- */

console.log('\n  C. controle negatif — un detecteur qui n attrape rien ne mesure rien');
{
  const reintroduction = `BEGIN;\n  SET ROLE tracefab_worker;\n  RESET ROLE;\nCOMMIT;\n`;
  verifier('controle negatif : un RESET ROLE reintroduit est detecte',
    occurrencesResetRole(reintroduction) === 1, `${occurrencesResetRole(reintroduction)} trouvee(s)`);

  const commente = `-- ancien code : RESET ROLE ne revenait pas au runner\nSELECT 1;\n`;
  verifier('controle negatif : la documentation du defaut n est PAS un defaut (commentaire ignore)',
    occurrencesResetRole(commente) === 0, `${occurrencesResetRole(commente)} trouvee(s)`);

  const sansCapture = `DECLARE\n  owner_oid OID;\nBEGIN\n  EXECUTE 'SET LOCAL ROLE tracefab_worker';\n  EXECUTE format('SET LOCAL ROLE %I', role_entree);\nEND`;
  verifier('controle negatif : une fonction sans capture d identite est signalee',
    !/role_entree\s+TEXT\s*:=\s*current_user/i.test(sansCapture), 'la regle de capture ne mord pas');

  const sansControle = `DECLARE\n  role_entree TEXT := current_user;\nBEGIN\n  EXECUTE format('SET LOCAL ROLE %I', role_entree);\n  RETURN QUERY SELECT 1;\nEND`;
  verifier('controle negatif : une fonction sans controle final est signalee',
    !(/IF\s+current_user\s*<>\s*role_entree\s+THEN[\s\S]{0,200}RAISE EXCEPTION/i.test(sansControle)),
    'la regle de controle final ne mord pas');
}

console.log(`\n  Restauration du role d entree : ${vertes}/${vertes + rouges} assertions vertes`);
if (echecs.length > 0) console.log(`  en echec : ${echecs.join(' · ')}`);
process.exit(rouges === 0 ? 0 : 1);
