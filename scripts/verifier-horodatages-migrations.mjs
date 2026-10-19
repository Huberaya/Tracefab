#!/usr/bin/env node
/**
 * Détecter les horodatages de migration dupliqués.
 *
 * POURQUOI CE CONTRÔLE EXISTE
 *
 * Quatre paires de migrations partagent le même horodatage. Prisma trie les
 * noms de dossier de façon lexicographique, donc le suffixe nominal départage
 * et l'ordre d'exécution reste déterministe : il n'y a pas d'ambiguïté
 * aujourd'hui. Mais aucun contrôle du dépôt ne le surveille — `check_migrations.ts`
 * se contente d'un `.sort()`, et `test_migration_history.mjs` ne cherche pas les
 * doublons. Une cinquième paire passerait inaperçue.
 *
 * POURQUOI UNE LISTE DE BASE PLUTÔT QU'UN RENOMMAGE
 *
 * `_prisma_migrations.migration_name` contient le nom du dossier — c'est ainsi
 * que `scripts/lire-historique-migrations.mjs` apparie l'historique appliqué aux
 * dossiers présents. Renommer un dossier déjà appliqué le ferait apparaître
 * comme « appliqué mais introuvable » sous l'ancien nom et « jamais appliqué »
 * sous le nouveau, donc provoquer une réapplication. Sur toute base déjà
 * migrée, dont Production, le renommage est à exclure.
 *
 * Les quatre paires existantes sont donc figées comme dette acceptée et
 * documentée. Ce contrôle échoue sur toute duplication NOUVELLE.
 *
 * STRICTEMENT EN LECTURE SEULE : aucun accès base, aucune connexion, aucune
 * écriture. Le script ne lit que le système de fichiers.
 *
 * Sorties : 0 aucune duplication nouvelle · 1 duplication nouvelle · 2 liste de
 * base introuvable ou illisible.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Surchargeable uniquement pour permettre à scripts/test_controle_migrations.mjs
// d'éprouver ce contrôle sur des arborescences synthétiques : un détecteur dont
// on ne peut pas provoquer l'échec n'est pas prouvé. En exécution normale la
// variable est absente et le dossier réel est utilisé.
const DOSSIER = process.env.TF_MIGRATIONS_DIR
  ? path.resolve(process.env.TF_MIGRATIONS_DIR)
  : path.join(RACINE, 'prisma', 'migrations');

/**
 * Dette acceptée : paires déjà présentes et appliquées sur les bases existantes.
 *
 * La liste fige les NOMS EXACTS, pas seulement les horodatages. Ne retenir que
 * l'horodatage laisserait passer l'ajout d'une troisième migration sur un
 * horodatage déjà endetté — défaut constaté au premier test de ce contrôle.
 *
 * Toute entrée ajoutée ici doit être justifiée en revue : c'est une dette, pas
 * une liste blanche décorative.
 */
const DETTE_ACCEPTEE = new Map([
  ['20261006120000', ['20261006120000_data_collection_bridge_and_quality_automation', '20261006120000_external_schema_bindings']],
  ['20261006200000', ['20261006200000_catalog_import_kind', '20261006200000_document_ai_automated_verification']],
  ['20261006220000', ['20261006220000_esg_pef_footprint_engine', '20261006220000_production_hardening']],
  ['20261017120000', ['20261017120000_active_tenant_context', '20261017120000_harden_dpp_table_privileges']],
]);

let entrees;
try {
  entrees = fs.readdirSync(DOSSIER, { withFileTypes: true });
} catch (e) {
  console.error(`  NON EXECUTE — ${DOSSIER} illisible : ${e.code ?? e.message}`);
  process.exit(2);
}

const parHorodatage = new Map();
for (const e of entrees) {
  if (!e.isDirectory()) continue;
  const m = /^(\d{14})_/.exec(e.name);
  if (!m) continue;
  const liste = parHorodatage.get(m[1]) ?? [];
  liste.push(e.name);
  parHorodatage.set(m[1], liste);
}

const duplications = [...parHorodatage.entries()]
  .filter(([, noms]) => noms.length > 1)
  .sort(([a], [b]) => a.localeCompare(b));

// Une duplication est « connue » seulement si les noms présents correspondent
// EXACTEMENT à la liste de base. Un nom en plus, en moins, ou différent, est
// traité comme une duplication nouvelle.
const nouvelles = [];
const connues = [];
for (const [t, noms] of duplications) {
  const attendus = DETTE_ACCEPTEE.get(t);
  const presents = [...noms].sort();
  if (attendus && JSON.stringify(attendus) === JSON.stringify(presents)) connues.push([t, noms]);
  else nouvelles.push([t, noms]);
}
const disparues = [...DETTE_ACCEPTEE.keys()].filter((t) => !parHorodatage.has(t)).sort();

// Une dette peut aussi se désynchroniser sans disparaître : si l'une des deux
// migrations d'un horodatage endetté est retirée ou renommée, l'horodatage
// subsiste avec un seul nom, ne constitue plus une duplication, et n'est donc
// plus examiné par la boucle ci-dessus. Sans ce contrôle la liste de base
// devenait silencieusement morte. Défaut révélé par le cas 6 de
// scripts/test_controle_migrations.mjs.
const desynchronisees = [...DETTE_ACCEPTEE.entries()]
  .filter(([t, attendus]) => {
    const presents = [...(parHorodatage.get(t) ?? [])].sort();
    return JSON.stringify(attendus) !== JSON.stringify(presents);
  })
  .map(([t]) => t)
  .sort();

console.log('');
console.log('  Horodatages de migration — contrôle des doublons');
console.log('  Lecture seule : aucune connexion, aucune écriture.');
console.log('');
console.log(`  migrations examinées      : ${[...parHorodatage.values()].reduce((n, l) => n + l.length, 0)}`);
console.log(`  horodatages distincts     : ${parHorodatage.size}`);
console.log(`  duplications totales      : ${duplications.length}`);
console.log(`  dette acceptée et présente: ${connues.length}`);
console.log(`  duplications NOUVELLES    : ${nouvelles.length}`);

if (connues.length > 0) {
  console.log('');
  console.log('  Dette acceptée (déjà appliquée sur les bases existantes) :');
  for (const [t, noms] of connues) {
    console.log(`    ${t}`);
    for (const n of noms.sort()) console.log(`      · ${n}`);
  }
}

if (disparues.length > 0) {
  console.log('');
  console.log('  ATTENTION — horodatages listés comme dette mais absents du dépôt :');
  for (const t of disparues) console.log(`    ${t}`);
  console.log('  La liste de base n\'est plus à jour : la justifier ou la corriger.');
}

if (desynchronisees.length > 0) {
  console.log('');
  console.log('  ATTENTION — dette acceptée désynchronisée du dépôt :');
  for (const t of desynchronisees) {
    const attendus = DETTE_ACCEPTEE.get(t);
    const presents = [...(parHorodatage.get(t) ?? [])].sort();
    console.log(`    ${t}`);
    console.log(`      attendu : ${attendus.join(', ')}`);
    console.log(`      présent : ${presents.join(', ') || '(aucune migration)'}`);
  }
  console.log('  Une migration endettée a été retirée ou renommée. Ne jamais renommer');
  console.log('  une migration déjà appliquée : _prisma_migrations conserve le nom du');
  console.log('  dossier et un renommage provoquerait une réapplication.');
}

if (nouvelles.length > 0) {
  console.log('');
  console.log('  ECHEC — duplication nouvelle :');
  for (const [t, noms] of nouvelles) {
    console.log(`    ${t}`);
    for (const n of noms.sort()) console.log(`      · ${n}`);
  }
  console.log('');
  console.log('  Choisir un horodatage strictement postérieur au dernier appliqué.');
  console.log('  Ne PAS renommer une migration déjà appliquée : _prisma_migrations');
  console.log('  conserve le nom du dossier et le renommage provoquerait une');
  console.log('  réapplication.');
  console.log('');
  process.exit(1);
}

if (disparues.length > 0 || desynchronisees.length > 0) process.exit(2);

console.log('');
console.log('  ok — aucune duplication nouvelle.');
console.log('');
process.exit(0);
