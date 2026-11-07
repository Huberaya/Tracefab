#!/usr/bin/env node
/**
 * Contrat de la MATRICE D'AUTORISATION formelle.
 *
 * Le document `docs/security/matrice-autorisations-tenant-actif.md` n'est pas
 * une prose libre : c'est un livrable de securite. Ce test empeche qu'une
 * ligne, une colonne ou un scenario soit retire sans que la suite
 * comportementale PostgreSQL jetable soit elle-meme revisitee.
 *
 * Il ne remplace PAS `npm run test:isolation:globale` : il verifie que les dix
 * scenarios decrits existent reellement dans la suite qui les execute.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(ROOT, 'docs', 'security', 'matrice-autorisations-tenant-actif.md'), 'utf8');
const suite = readFileSync(join(ROOT, 'scripts', 'test_isolation_globale_pglite.mjs'), 'utf8');

let echecs = 0;
const ok = (condition, libelle) => {
  if (condition) console.log(`  ok    ${libelle}`);
  else { echecs += 1; console.error(`  ECHEC ${libelle}`); }
};

for (const colonne of [
  'Propriétaire', 'Tenant actif', 'Organisation fournisseur',
  'Organisation marque', 'Relation', 'Ressource', 'Permission', 'Action',
]) {
  ok(doc.includes(`| ${colonne} |`) || doc.includes(`${colonne}**`),
    `colonne obligatoire présente : ${colonne}`);
}

const lignes = [...doc.matchAll(/^\|\s*(\d{1,2})\s*\|/gm)].map((m) => Number(m[1]));
ok(lignes.length === 10 && lignes.every((n, i) => n === i + 1),
  `10 scénarios numérotés de 1 à 10 (trouvés : ${lignes.join(', ')})`);

for (let n = 1; n <= 10; n += 1) {
  ok(new RegExp(`^\\|\\s*${n}\\s*\\|.*\\*\\*(AUTORISÉ|REFUSÉ)`, 'm').test(doc),
    `scénario ${n} : décision explicite`);
  ok(new RegExp(`ok\\('${n}\\.`).test(suite),
    `scénario ${n} : au moins une assertion exécutée dans la suite jetable`);
}

ok(doc.includes('20261105180000_active_tenant_access_guards'),
  'la migration des gardes de tenant est référencée');
ok(doc.includes('documents_restrict_active_tenant'),
  'la politique RLS restrictive est référencée');
ok(doc.includes('Niveau de preuve') && doc.includes('ne valide ni Vercel Preview'),
  'le niveau de preuve et ses limites sont explicités');
ok(doc.includes('URL présignée') && doc.includes('clés de stockage'),
  'stockage et URLs présignées sont traités');

console.log(`\nMatrice d'autorisation : ${echecs} échec(s).`);
process.exit(echecs === 0 ? 0 : 1);
