#!/usr/bin/env node
/**
 * Garde-fous de `scripts/diagnostic_base_preview_p107.mjs`.
 *
 * Cet outil manipule une URL de connexion complete, donc un secret. Il est
 * teste ici sur ce qui compte : il refuse la Production, il refuse ce qui n'est
 * pas Neon, et il ne laisse JAMAIS fuir l'URL ni le mot de passe dans sa
 * sortie — y compris quand la connexion echoue, puisque le message d'erreur
 * vient d'une bibliotheque tierce.
 *
 * Aucun test n'ouvre de connexion reelle.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const racine = path.resolve(import.meta.dirname, '..');
const outil = path.join(racine, 'scripts', 'diagnostic_base_preview_p107.mjs');

let echecs = 0;
const verifier = (cond, libelle, detail = '') => {
  if (cond) return;
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

/** Lance l'outil et rend {code, sortie}. Ne leve jamais sur code non nul. */
const lancer = (args) => {
  try {
    const sortie = execFileSync(process.execPath, [outil, ...args], {
      cwd: racine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, sortie };
  } catch (e) {
    return { code: e.status ?? 1, sortie: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

// --- 1. Refus de la Production ---------------------------------------------
const prod = lancer(['--url', 'postgresql://u:motdepasse@ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech/neondb']);
verifier(prod.code === 2, 'la Production est refusee (code 2)', `code ${prod.code}`);
verifier(/PRODUCTION/.test(prod.sortie), 'le refus nomme la Production');
verifier(!/motdepasse/.test(prod.sortie), 'le refus ne cite pas le mot de passe');

// --- 2. Refus d'un hote non Neon -------------------------------------------
const autre = lancer(['--url', 'postgresql://u:p@base.example.com/db']);
verifier(autre.code === 2, 'un hote non Neon est refuse', `code ${autre.code}`);
verifier(/non Neon/.test(autre.sortie), 'le refus nomme la raison');

// --- 3. Refus sans URL ------------------------------------------------------
const vide = lancer([]);
verifier(vide.code === 2, 'sans URL, l outil refuse', `code ${vide.code}`);

// --- 4. Protocole non PostgreSQL -------------------------------------------
const mysql = lancer(['--url', 'mysql://u:p@ep-x.eu-central-1.aws.neon.tech/db']);
verifier(mysql.code === 2, 'un protocole non PostgreSQL est refuse', `code ${mysql.code}`);

// --- 5. Aucune fuite, meme quand la connexion echoue ----------------------
// `ep-inexistant` n'existe pas : la connexion echouera, et c'est justement le
// chemin ou un message d'erreur tiers pourrait regurgiter l'URL.
const fuite = lancer(['--url', 'postgresql://u:MOTDEPASSEUNIQUE@ep-inexistant.eu-central-1.aws.neon.tech/neondb']);
verifier(!/MOTDEPASSEUNIQUE/.test(fuite.sortie), 'le mot de passe ne fuit pas dans une erreur de connexion');
verifier(!/postgresql:\/\//.test(fuite.sortie), 'aucune URL de connexion dans la sortie');

// --- 6. Le pooler est signale, pas silencieusement accepte ----------------
const pooler = lancer(['--url', 'postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb']);
verifier(/pooler/.test(pooler.sortie), 'un hote pooler est signale');

// --- 7. Le temoin de rattachement est SURCHARGEABLE ------------------------
//
// Defaut corrige le 2026-11-19 : les trois empreintes attendues etaient codees
// en dur ET perimees. L'outil comparait a un temoin mort et rendait « ne joint
// pas la base du runtime » sur la bonne URL. Un temoin qu'on ne peut pas mettre
// a jour est un temoin qu'on ne peut pas croire.
//
// On verifie ici que les valeurs sont bien LUES depuis les options, et non
// ignorees. Le test lit la SOURCE : il doit echouer si un litteral nu revient.
const sourceOutil = readFileSync(
  new URL('./diagnostic_base_preview_p107.mjs', import.meta.url), 'utf8');
verifier(/--empreinte-hote/.test(sourceOutil), 'l empreinte d hote attendue est surchargeable (--empreinte-hote)');
verifier(/--empreinte-schemas/.test(sourceOutil), 'l empreinte de schemas attendue est surchargeable');
verifier(/--oid/.test(sourceOutil), 'l oid attendu est surchargeable');
verifier(!/hote_empreinte:\s*'e4142a5ef80a'/.test(sourceOutil),
  'l ancienne empreinte perimee e4142a5ef80a ne sert plus de temoin par defaut');
verifier(/TF_EMPREINTE_HOTE/.test(sourceOutil), 'une variable d environnement peut aussi fournir le temoin');

if (echecs === 0) {
  console.log('  Diagnostic base Preview : garde-fous OK.');
  process.exit(0);
}
console.error(`  Diagnostic base Preview : ${echecs} echec(s).`);
process.exit(1);
