#!/usr/bin/env node
/**
 * Contrôle — la validation TLS ne doit jamais être désactivée.
 *
 * Un objet `ssl` dont `rejectUnauthorized` vaut la valeur booléenne fausse
 * laisse n'importe quel intermédiaire présenter un certificat auto-signé. La
 * connexion reste chiffrée en apparence ; elle n'est plus authentifiée. Sur des
 * connexions qui transportent un mot de passe de rôle et des données de
 * production, c'est un défaut de sécurité, pas un réglage de confort.
 *
 * Ce contrôle est un parcours textuel : il lit les sources, n'ouvre aucune
 * connexion, n'exécute rien. Il couvre `scripts/` et `api/`.
 *
 * Il vérifie aussi que le réglage partagé existe et reste correct, pour que la
 * correction ne puisse pas être défaite en silence.
 *
 * STRICTEMENT EN LECTURE SEULE : aucune connexion, aucune écriture.
 *
 * Sorties : 0 conforme · 1 défaut trouvé · 2 environnement illisible.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RACINES = ['scripts', 'api'];
const EXTENSIONS = new Set(['.mjs', '.ts', '.js', '.cjs']);

// Formes fautives : la propriété avec la valeur booléenne fausse, y compris
// écrite avec `=`, ou passée sous une forme non booléenne équivalente.
//
// Les motifs sont construits par concaténation. Écrire le littéral complet dans
// ce fichier ferait du contrôle son propre faux positif — défaut constaté au
// premier lancement de ce script.
const PROP = 'rejectUnauthorized';
const FAUX = ['fals', 'e'].join('');
const FORMES_FAUTIVES = [
  { re: new RegExp(`${PROP}\\s*:\\s*${FAUX}\\b`), motif: `${PROP} à false` },
  { re: new RegExp(`${PROP}\\s*=\\s*${FAUX}\\b`), motif: `${PROP} affecté à false` },
  { re: new RegExp(`${PROP}\\s*:\\s*(?:0|'${FAUX}'|"${FAUX}")\\b`), motif: `${PROP} à valeur fausse non booléenne` },
];

function fichiersSous(racine) {
  const abs = path.join(RACINE, racine);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const pile = [abs];
  while (pile.length > 0) {
    const dir = pile.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        pile.push(p);
      } else if (EXTENSIONS.has(path.extname(e.name))) {
        out.push(p);
      }
    }
  }
  return out;
}

let fichiers;
try {
  fichiers = RACINES.flatMap(fichiersSous);
} catch (e) {
  console.error(`  NON EXECUTE — sources illisibles : ${e.code ?? e.message}`);
  process.exit(2);
}

const defauts = [];
for (const f of fichiers) {
  const lignes = fs.readFileSync(f, 'utf8').split('\n');
  lignes.forEach((ligne, i) => {
    const code = ligne.trim();
    // Un commentaire qui explique le défaut n'est pas le défaut.
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
    for (const { re, motif } of FORMES_FAUTIVES) {
      if (re.test(ligne)) {
        defauts.push({ fichier: path.relative(RACINE, f), ligne: i + 1, motif });
      }
    }
  });
}

console.log('');
console.log('  Validation TLS des connexions PostgreSQL — contrôle');
console.log('  Lecture seule : aucune connexion ouverte.');
console.log('');
console.log(`  fichiers parcourus : ${fichiers.length}`);

// Le helper partagé doit exister et rendre une validation active.
const helper = path.join(RACINE, 'scripts', 'lib', 'pg-ssl.mjs');
if (!fs.existsSync(helper)) {
  console.log('');
  console.log('  ECHEC — scripts/lib/pg-ssl.mjs est absent.');
  console.log('  Le réglage TLS partagé a disparu : chaque nouveau site réécrira');
  console.log('  son propre objet ssl, et le défaut peut revenir.');
  process.exit(1);
}
const sourceHelper = fs.readFileSync(helper, 'utf8');
if (!/rejectUnauthorized\s*:\s*true/.test(sourceHelper)) {
  console.log('');
  console.log('  ECHEC — pg-ssl.mjs ne rend plus une validation active.');
  process.exit(1);
}
console.log('  helper partagé     : present, validation active');

if (defauts.length > 0) {
  console.log('');
  console.log(`  ECHEC — ${defauts.length} site(s) desactive(nt) la validation du certificat :`);
  for (const d of defauts) {
    console.log(`    ${d.fichier}:${d.ligne}  (${d.motif})`);
  }
  console.log('');
  console.log('  Corriger en employant sslDepuisUrl() de scripts/lib/pg-ssl.mjs.');
  console.log('  Un magasin d autorites prive se fournit par NODE_EXTRA_CA_CERTS,');
  console.log('  jamais en desactivant la verification.');
  console.log('');
  process.exit(1);
}

console.log('  sites fautifs      : 0');
console.log('');
console.log('  ok — aucune connexion ne désactive la validation du certificat.');
console.log('');
process.exit(0);
