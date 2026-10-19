#!/usr/bin/env node
/**
 * Épreuve du contrôle d'horodatages de migrations.
 *
 * `verifier-horodatages-migrations.mjs` classe les duplications en dette
 * acceptée et en duplications nouvelles. Un tel classement n'a de valeur que si
 * l'on peut provoquer son échec : ce contrôle construit donc des arborescences
 * synthétiques et vérifie le code de sortie de chaque cas.
 *
 * Cas couverts :
 *   1. l'état réel du dépôt passe ;
 *   2. une nouvelle collision échoue ;
 *   3. une TROISIÈME migration sur un horodatage déjà endetté échoue — défaut
 *      réel constaté lorsque la liste blanche ne retenait que l'horodatage ;
 *   4. renommer une migration endettée échoue (liste blanche périmée) ;
 *   5. ajouter une migration corrective à horodatage unique passe : le contrôle
 *      ne bloque pas le travail légitime et n'exige pas de falsifier l'historique.
 *
 * Sorties : 0 conforme · 1 défaut.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DETECTEUR = path.join(RACINE, 'scripts', 'verifier-horodatages-migrations.mjs');
const REEL = path.join(RACINE, 'prisma', 'migrations');

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
    console.log(`    ECHEC ${etiquette}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Copie l'arborescence réelle dans un dossier temporaire. */
function copieReelle() {
  const cible = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-epreuve-'));
  fs.cpSync(REEL, cible, { recursive: true });
  return cible;
}

function ajouteMigration(dossier, nom) {
  const d = path.join(dossier, nom);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'migration.sql'), '-- migration synthetique de test\nSELECT 1;\n');
}

/** Lance le détecteur sur un dossier et renvoie son code de sortie. */
function lance(dossier) {
  try {
    const sortie = execFileSync('node', [DETECTEUR], {
      env: { ...process.env, TF_MIGRATIONS_DIR: dossier },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, sortie };
  } catch (e) {
    return { code: e.status ?? -1, sortie: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const temporaires = [];
try {
  /* --- 1. État réel ------------------------------------------------------- */
  console.log('\n  1. état réel du dépôt');
  const reel = lance(REEL);
  verifier('l état actuel accepté passe (sortie 0)', reel.code === 0, `sortie ${reel.code}`);

  /* --- 2. Nouvelle collision ---------------------------------------------- */
  console.log('\n  2. nouvelle collision');
  {
    const d = copieReelle();
    temporaires.push(d);
    // Deux migrations sur un horodatage qui n'existe pas encore : duplication
    // nouvelle, aucune dette ne peut la couvrir.
    ajouteMigration(d, '20261101090000_premiere_nouvelle');
    ajouteMigration(d, '20261101090000_seconde_nouvelle');
    const r = lance(d);
    verifier('une nouvelle collision échoue (sortie 1)', r.code === 1, `sortie ${r.code}`);
    verifier(
      'le message nomme l horodatage en cause',
      r.sortie.includes('20261101090000'),
      'horodatage absent du message',
    );
  }

  /* --- 3. Troisième migration sur un horodatage endetté -------------------- */
  console.log('\n  3. troisième migration sur un horodatage déjà endetté');
  {
    const d = copieReelle();
    temporaires.push(d);
    // 20261017120000 porte déjà deux migrations acceptées. Une troisième ne doit
    // PAS passer : la liste blanche fige des noms exacts, pas un horodatage.
    ajouteMigration(d, '20261017120000_troisieme_intruse');
    const r = lance(d);
    verifier(
      'une troisième migration sur horodatage endetté échoue (sortie 1)',
      r.code === 1,
      `sortie ${r.code}`,
    );
    verifier(
      'le message nomme la migration intruse',
      r.sortie.includes('20261017120000_troisieme_intruse'),
      'migration intruse absente du message',
    );
  }

  /* --- 4. Migration endettée renommée -------------------------------------- */
  console.log('\n  4. renommage d une migration endettée');
  {
    const d = copieReelle();
    temporaires.push(d);
    fs.renameSync(
      path.join(d, '20261017120000_active_tenant_context'),
      path.join(d, '20261017120000_active_tenant_context_renomme'),
    );
    const r = lance(d);
    verifier(
      'renommer une migration endettée est signalé (sortie 1 ou 2)',
      r.code === 1 || r.code === 2,
      `sortie ${r.code}`,
    );
  }

  /* --- 5. Migration corrective légitime ------------------------------------ */
  console.log('\n  5. ajout d une migration corrective légitime');
  {
    const d = copieReelle();
    temporaires.push(d);
    ajouteMigration(d, '20261102100000_correction_legitime');
    const r = lance(d);
    verifier(
      'une migration corrective à horodatage unique passe (sortie 0)',
      r.code === 0,
      `sortie ${r.code}`,
    );
  }

  /* --- 6. La dette acceptée est bien celle du dépôt ------------------------ */
  console.log('\n  6. cohérence de la liste de dette');
  {
    const d = copieReelle();
    temporaires.push(d);
    // Retirer une migration endettée doit être signalé : une liste blanche qui
    // ne correspond plus au dépôt est une liste morte.
    fs.rmSync(path.join(d, '20261006220000_production_hardening'), { recursive: true, force: true });
    const r = lance(d);
    verifier(
      'une dette acceptée disparue est signalée (sortie 2)',
      r.code === 2,
      `sortie ${r.code}`,
    );
  }
} finally {
  for (const d of temporaires) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' ; ')}`);
  process.exit(1);
}
console.log('  ok — le contrôle d horodatages est éprouvé, y compris en échec.');
process.exit(0);
