#!/usr/bin/env node
/**
 * Ordre et unicite des migrations — le risque que rien ne mesurait.
 *
 * POURQUOI CE TEST EXISTE
 * -----------------------
 * `prisma migrate` ordonne les migrations par NOM DE DOSSIER, c'est-a-dire par
 * horodatage. Quand deux migrations partagent le meme horodatage, leur ordre
 * relatif n'est plus fixe par le temps mais par l'ordre ALPHABETIQUE de leur
 * suffixe. Deux consequences :
 *
 *   - l'ordre applique depend d'un detail qui n'a jamais ete decide ;
 *   - deux environnements qui divergent sur ce detail appliquent deux ordres
 *     differents, et `_prisma_migrations` finit par diverger sans que personne
 *     n'ait modifie de migration.
 *
 * MESURE DU 2026-11-16 (lecture seule, aucun appel reseau) : le depot contient
 * 100 migrations et QUATRE paires d'horodatage identique :
 *
 *   20261006120000  data_collection_bridge_and_quality_automation / external_schema_bindings
 *   20261006200000  catalog_import_kind / document_ai_automated_verification
 *   20261006220000  esg_pef_footprint_engine / production_hardening
 *   20261017120000  active_tenant_context / harden_dpp_table_privileges
 *
 * Aucune des quatre paires ne se cite mutuellement (verifie ici), donc RIEN
 * N'EST CASSE aujourd'hui. C'est precisement pourquoi ce test n'echoue pas sur
 * leur existence : il echoue sur une dependance croisee, ou sur une paire
 * NOUVELLE. Une migration ajoutee demain avec un horodatage deja pris serait,
 * elle, un defaut a corriger avant livraison.
 *
 * CE QU'IL N'EST PAS : il ne renomme rien et ne touche pas `_prisma_migrations`.
 * Renommer une migration deja appliquee casserait l'historique des
 * environnements existants ; le diagnostic se fait ici, la decision appartient
 * au proprietaire.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dossier = path.join(racine, 'prisma', 'migrations');

// Paires d'horodatage deja presentes dans l'historique livre. Elles sont
// NOMMEES, pas tolerees en bloc : une cinquieme paire fera echouer ce test et
// devra etre ajoutee ici par une decision explicite, avec sa justification.
const PAIRES_HISTORIQUES = new Map([
  ['20261006120000', ['data_collection_bridge_and_quality_automation', 'external_schema_bindings']],
  ['20261006200000', ['catalog_import_kind', 'document_ai_automated_verification']],
  ['20261006220000', ['esg_pef_footprint_engine', 'production_hardening']],
  ['20261017120000', ['active_tenant_context', 'harden_dpp_table_privileges']],
]);

let echecs = 0;
const verifier = (cond, nom, detail = '') => {
  if (cond) console.log(`  ok    ${nom}`);
  else { console.log(`  ECHEC ${nom}${detail ? ` — ${detail}` : ''}`); echecs += 1; }
};

console.log('Ordre et unicite des migrations');

verifier(existsSync(dossier), 'le dossier des migrations existe');
const dossiers = readdirSync(dossier, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

// 1. Forme : chaque dossier commence par exactement 14 chiffres.
const malformes = dossiers.filter((d) => !/^\d{14}_/.test(d));
verifier(malformes.length === 0, 'chaque migration commence par un horodatage a 14 chiffres',
  malformes.slice(0, 3).join(', '));

// 2. Chaque migration porte un migration.sql non vide.
const sansSQL = dossiers.filter((d) => {
  const f = path.join(dossier, d, 'migration.sql');
  return !existsSync(f) || readFileSync(f, 'utf8').trim().length === 0;
});
verifier(sansSQL.length === 0, 'chaque migration contient un migration.sql non vide',
  sansSQL.slice(0, 3).join(', '));

// 3. Unicite des horodatages, sauf paires historiques nommees.
const parHorodatage = new Map();
for (const d of dossiers) {
  const ts = d.slice(0, 14);
  if (!parHorodatage.has(ts)) parHorodatage.set(ts, []);
  parHorodatage.get(ts).push(d.slice(15));
}
const collisions = [...parHorodatage.entries()].filter(([, noms]) => noms.length > 1);
const nouvelles = collisions.filter(([ts]) => !PAIRES_HISTORIQUES.has(ts));
verifier(nouvelles.length === 0,
  'aucune NOUVELLE collision d horodatage',
  nouvelles.map(([ts, noms]) => `${ts} (${noms.join(', ')})`).join(' ; '));

// 4. Les paires historiques sont exactement celles declarees.
//    Une paire declaree qui a disparu, ou dont les membres ont change, signifie
//    que l'historique a bouge : c'est un fait a signaler, pas a ignorer.
for (const [ts, attendus] of PAIRES_HISTORIQUES) {
  const reels = (parHorodatage.get(ts) || []).slice().sort();
  verifier(JSON.stringify(reels) === JSON.stringify(attendus.slice().sort()),
    `la paire ${ts} est inchangee`, `attendu ${attendus.join(', ')} / reel ${reels.join(', ')}`);
}

// 5. LE CONTROLE QUI COMPTE : aucune paire ne doit etre une dependance croisee.
//    Deux migrations de meme horodatage qui s'appellent l'une l'autre rendraient
//    l'ordre alphabetique SIGNIFICATIF — donc fragile.
for (const [ts, noms] of collisions) {
  if (noms.length !== 2) continue;
  const [a, b] = noms;
  const sqlA = readFileSync(path.join(dossier, `${ts}_${a}`, 'migration.sql'), 'utf8');
  const sqlB = readFileSync(path.join(dossier, `${ts}_${b}`, 'migration.sql'), 'utf8');
  const croisee = sqlA.includes(b) || sqlB.includes(a);
  verifier(!croisee, `la paire ${ts} n a aucune dependance croisee`,
    croisee ? 'ordre alphabetique significatif' : '');
}

// 6. Comptage : il est RECALCULE, jamais recopie d'une constante.
//    Un nombre fige en dur ne detecte pas une migration perdue.
const total = dossiers.length;
verifier(total >= 100, 'au moins 100 migrations presentes', `${total}`);
console.log(`  info  ${total} migrations, ${collisions.length} paire(s) d horodatage partage`);

console.log(echecs === 0 ? '  Ordre des migrations : OK.' : `  Ordre des migrations : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
