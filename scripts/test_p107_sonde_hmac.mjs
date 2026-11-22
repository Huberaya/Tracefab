#!/usr/bin/env node
/**
 * P10.7 — chantier C : la sonde de configuration HMAC ne publie QUE des
 * booléens, et elle les publie JUSTES.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Le chantier C demande de mesurer, sur l'environnement cible, la présence et
 * la validité de la clé HMAC, sans jamais en lire la valeur. Une sonde de
 * configuration est donc, par construction, du code qui manipule un secret.
 * Deux façons de la rater :
 *
 *   1. elle FUITE — un message d'erreur, un `JSON.stringify` d'environnement,
 *      un extrait de clé « pour diagnostiquer ». Une fuite dans un journal est
 *      définitive : on ne peut pas la révoquer ;
 *   2. elle MENT — elle annonce « configurée » sur une clé malformée, et
 *      l'opérateur lit un feu vert alors que l'application ne signe rien.
 *
 * Ce test couvre les deux, avec des clés FACTICES générées ici. Aucune valeur
 * réelle n'entre dans ce fichier ni dans sa sortie.
 *
 * Sorties : 0 conforme · 1 défaut.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
// La sonde est en TypeScript : elle importe la fonction de validation du
// runtime au lieu d'en recopier la règle (une copie dérive silencieusement).
const SONDE = join(RACINE, 'scripts/sonde_p107_hmac.ts');

let vertes = 0;
let rouges = 0;
const echecs = [];
function verifier(etiquette, ok, detail) {
  if (ok) {
    vertes += 1;
    console.log(`    ok    ${etiquette}`);
  } else {
    rouges += 1;
    echecs.push(etiquette);
    console.log(`    ECHEC ${etiquette}${detail === undefined ? '' : ` — observé : ${detail}`}`);
  }
}

/** Lance la sonde avec un environnement donné, sans hériter de la vraie clé. */
function lancer(cle, { argument = null } = {}) {
  const env = { ...process.env };
  delete env.TRACEFAB_IDENTITY_KEY;
  if (cle !== null) env.TRACEFAB_IDENTITY_KEY = cle;
  const args = ['--import', 'tsx', SONDE];
  if (argument) args.push(argument);
  const r = spawnSync(process.execPath, args, { cwd: RACINE, env, encoding: 'utf8' });
  return { code: r.status, sortie: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/* --- 1. Les trois états, et le code de sortie qui les distingue ---------- */

console.log('\n  A. trois états distincts, trois codes de sortie');

// Clé FACTICE : 32 octets aléatoires, jamais utilisée ailleurs, jamais affichée.
const cleFactice = randomBytes(32).toString('hex');

{
  const r = lancer(null);
  verifier('clé absente : code 0 (état de transition, pas une erreur)', r.code === 0, r.code);
  verifier('clé absente : mode « non_configure »', /"mode": ?"non_configure"/.test(r.sortie), r.sortie.slice(0, 120));
  verifier('clé absente : `configured: false`', /"configured": ?false/.test(r.sortie), 'annoncée configurée');
}

{
  const r = lancer(cleFactice);
  verifier('clé valide : code 0', r.code === 0, r.code);
  verifier('clé valide : mode « signe »', /"mode": ?"signe"/.test(r.sortie), r.sortie.slice(0, 120));
  verifier('clé valide : `configured: true`', /"configured": ?true/.test(r.sortie), 'annoncée non configurée');
  verifier('clé valide : la présence est dite sans la valeur', /"presente": ?true/.test(r.sortie), 'présence non rapportée');
}

{
  // Présente mais malformée : c'est une ERREUR D'EXPLOITATION (P10.6), pas un
  // état de transition. Elle doit être visible, donc code non nul.
  const r = lancer('pas-de-l-hexadecimal'.repeat(4));
  verifier('clé invalide : code 1 (erreur d exploitation visible)', r.code === 1, r.code);
  verifier('clé invalide : mode « cle_invalide »', /"mode": ?"cle_invalide"/.test(r.sortie), r.sortie.slice(0, 120));
  verifier('clé invalide : `configured: false` — jamais un feu vert', /"configured": ?false/.test(r.sortie), 'annoncée configurée');
}

{
  // Longueur IMPAIRE : le cas qui produisait un HMAC sur une clé tronquée.
  const r = lancer('a'.repeat(65));
  verifier('clé de longueur impaire : invalide, pas tronquée', /"mode": ?"cle_invalide"/.test(r.sortie), r.sortie.slice(0, 120));
  const r2 = lancer('a'.repeat(63));
  verifier('clé trop courte (63) : invalide', /"mode": ?"cle_invalide"/.test(r2.sortie), r2.sortie.slice(0, 120));
}

/* --- 2. Aucune fuite : pas un fragment de la clé dans la sortie ---------- */

console.log('\n  B. la sortie ne contient aucun fragment de la clé');

{
  const r = lancer(cleFactice);
  const fragments = [];
  // Toute fenêtre de 8 caractères de la clé est déjà une fuite exploitable
  // pour corréler deux environnements. On teste donc court, exprès.
  for (let i = 0; i + 8 <= cleFactice.length; i += 1) fragments.push(cleFactice.slice(i, i + 8));
  const fuites = fragments.filter((f) => r.sortie.includes(f));
  verifier('aucune fenêtre de 8 caractères de la clé dans la sortie', fuites.length === 0, `${fuites.length} fuite(s)`);
  verifier('la sortie ne contient pas la clé entière', !r.sortie.includes(cleFactice), 'clé recopiée');
}

{
  // Une clé invalide peut ressembler à un message d'erreur : le risque de la
  // recopier « pour aider au diagnostic » est plus élevé sur ce chemin.
  const invalide = `zz-${randomBytes(16).toString('hex')}`.repeat(2);
  const r = lancer(invalide);
  verifier('même sur le chemin d erreur, la clé invalide n est pas recopiée',
    !r.sortie.includes(invalide.slice(0, 12)), 'clé présente dans le message d erreur');
}

/* --- 3. La sonde se décrit comme non probante pour Preview↔Production ---- */

console.log('\n  C. périmètre déclaré — ce que la sonde ne prouve pas');

{
  const r = lancer(cleFactice);
  verifier('la sonde nomme explicitement la cohérence Preview↔Production comme non mesurée',
    /preview_production/.test(r.sortie), 'périmètre non déclaré');
  verifier('la sonde déclare qu elle ne lit aucun secret de la base',
    /cles_base/.test(r.sortie), 'périmètre non déclaré');
  verifier('la rotation à deux clés actives est attribuée à la BASE, pas à la sonde',
    /rotation/.test(r.sortie), 'rotation non située');
}

/* --- 4. La sonde est utilisable sur l'environnement cible ---------------- */

console.log('\n  D. la sonde accepte une étiquette d environnement sans la confondre avec une preuve');

{
  const r = lancer(cleFactice, { argument: 'production' });
  verifier('une étiquette est acceptée et recopiée telle quelle', /"environnement": ?"production"/.test(r.sortie), r.sortie.slice(0, 160));
  verifier('l étiquette ne change pas le verdict (la valeur mesurée reste la même)',
    /"configured": ?true/.test(r.sortie), 'verdict dépendant de l étiquette');
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (echecs.length > 0) console.log(`  en échec : ${echecs.join(' · ')}`);
process.exit(rouges === 0 ? 0 : 1);
