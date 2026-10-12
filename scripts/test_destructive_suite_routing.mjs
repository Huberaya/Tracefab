#!/usr/bin/env node
/**
 * Politique de routage des suites destructives.
 *
 * Retirer une etape d'un workflow protege ce workflow. Ce controle protege
 * l'avenir : toute suite qui ecrit en base doit passer par le lanceur commun
 * `scripts/run-db-suite.mjs`, donc par la garde de cible, quel que soit le
 * chemin qui l'appelle.
 *
 * Ce test est volontairement en refus par defaut : un fichier destructif
 * inconnu fait echouer la CI. Le declarer est un acte explicite ; l'oublier
 * n'est pas possible.
 *
 * Limite assumee : la detection est statique (motifs sur le source), donc elle
 * peut produire des faux positifs. Un faux positif se resout en declarant le
 * fichier, ce qui est precisement le comportement souhaite.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const WRAPPER = 'scripts/run-db-suite.mjs';

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

/** Motifs d'ecriture : SQL et mutations Prisma. */
const WRITE_PATTERNS = [
  /INSERT\s+INTO/i, /UPDATE\s+[\w".]+\s+SET/i, /DELETE\s+FROM/i,
  /CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|ROLE|POLICY|INDEX|FUNCTION|TRIGGER|SCHEMA|TYPE)/i,
  /DROP\s+(?:TABLE|ROLE|POLICY|FUNCTION|TRIGGER|SCHEMA|TYPE|DATABASE)/i,
  /ALTER\s+(?:TABLE|ROLE|DEFAULT\s+PRIVILEGES|POLICY)/i,
  /GRANT\s+/i, /REVOKE\s+/i,
  /\.create\(/, /\.createMany\(/, /\.update\(/, /\.updateMany\(/,
  /\.delete\(/, /\.deleteMany\(/, /\.upsert\(/,
  /\$executeRaw/,
];

/** Suites qui ecrivent et ne doivent jamais s'executer hors lanceur. */
const MUST_ROUTE_THROUGH_WRAPPER = [
  'scripts/test_neon_security.mjs',
  'scripts/test_neon_supplier_flow.mjs',
  'scripts/test_neon_supplier_advanced.mjs',
  'scripts/test_neon_product_flow.mjs',
  'scripts/test_neon_quality_flow.mjs',
  'scripts/test_neon_data_collection_flow.mjs',
  'scripts/test_neon_bulk_operations_chantier8.mjs',
  'scripts/test_neon_wallet_chantier9.ts',
  'scripts/test_neon_chantier10_storage.ts',
  'scripts/test_supplier_advanced.mjs',
];

/**
 * Suites destructives presentes dans le depot mais rattachees a aucune
 * commande. Elles sont declarees ici pour qu'elles ne puissent pas etre
 * oubliees : ajouter une suite a ce registre est une decision, pas un oubli.
 * Aucune n'est executable par `npm test`, `npm run build` ni par la CI.
 */
const UNWIRED_DESTRUCTIVE_REGISTER = [
  'scripts/test_neon_chantier7_mass_balance.mjs',
  'scripts/test_neon_document_ai.mjs',
  'scripts/test_neon_green_claims.mjs',
  'scripts/test_neon_pef.mjs',
  'scripts/test_neon_plm_erp_gs1.mjs',
  'scripts/test_neon_quality_cap.mjs',
  'scripts/test_neon_universal_passport.mjs',
];

/** Suites de base en lecture seule : pas de garde necessaire, mais declarees. */
const READ_ONLY_DB_SUITES = [
  'scripts/test_rls_isolation.mjs',        // epreuve d'isolation, uniquement des SELECT
  'scripts/audit_neon_readonly.mjs',       // audit de privileges, uniquement des SELECT de catalogue
];

/**
 * Suites dont la seule ecriture est une sonde creee DANS une transaction
 * toujours annulee. Elles ne doivent pas etre classees « lecture seule »
 * (cette affirmation serait fausse) ni « destructives » (elles ne laissent
 * aucune trace). La suite verifie que la transaction et l'annulation sont
 * bien presentes, sans quoi la declaration serait un blanc-seing.
 */
const ROLLBACK_ONLY_DB_SUITES = [
  'scripts/test_neon_privileges.mjs',
];

/**
 * Outils d'exploitation : ils ECRIVENT volontairement vers une cible nommee
 * par l'operateur. Les faire passer par la garde de cible les priverait de
 * leur fonction — amorcer un environnement reel fait partie du metier.
 *
 * Ce qui les rend surs n'est donc pas la garde, c'est le fait qu'AUCUNE
 * commande de test, de build ou de CI ne les invoque. C'est verifie plus bas :
 * un outil d'exploitation qui deviendrait declenchable automatiquement ferait
 * echouer cette suite.
 */
const OPERATOR_WRITER_SCRIPTS = [
  'scripts/seed_pilot.ts',                  // amorcage d un environnement pilote
  'scripts/verifier_checksums_migrations.mjs', // realignement des checksums, sur --appliquer uniquement
];

/**
 * Fichiers qui contiennent les motifs d ecriture sans ecrire en base :
 * soit ils les citent (cette suite, qui les liste), soit ils les ecrivent
 * dans des projets jetables sous /tmp.
 */
const PATTERN_ONLY_FILES = [
  'scripts/test_destructive_suite_routing.mjs',
  'scripts/test_prisma_client_check.mjs',
];

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

function scriptInvocations(target) {
  // Les scripts npm qui invoquent ce fichier, quelle que soit la forme.
  return Object.entries(scripts).filter(([, command]) => command.includes(target));
}

console.log('\n  A. les suites destructives passent par le lanceur commun');
for (const target of MUST_ROUTE_THROUGH_WRAPPER) {
  if (!existsSync(join(ROOT, target))) { ko(`fichier declare introuvable : ${target}`); continue; }
  const invocations = scriptInvocations(target);
  if (invocations.length === 0) { ko(`aucune commande npm n invoque ${target}`); continue; }
  const direct = invocations.filter(([, command]) => !command.includes(WRAPPER));
  if (direct.length === 0) {
    ok(`${target} — ${invocations.length} commande(s), toutes via ${WRAPPER}`);
  } else {
    ko(`${target} invoquee SANS la garde par : ${direct.map(([k]) => k).join(', ')}`);
  }
}

console.log('\n  B. le lanceur applique bien la garde avant d executer');
{
  const wrapper = existsSync(join(ROOT, WRAPPER)) ? readFileSync(join(ROOT, WRAPPER), 'utf8') : '';
  wrapper.includes('requireThrowawayDb') ? ok('le lanceur appelle la garde de cible') : ko('le lanceur n appelle pas la garde');
  wrapper.includes("'inherit'") ? ok('le lanceur transmet la sortie et le code de retour') : ko('le lanceur ne relaie pas la sortie');
}

console.log('\n  C. aucune suite destructive non declaree');
{
  const candidates = readdirSync(SCRIPTS).filter((f) => /\.(mjs|ts|js)$/.test(f));
  const undeclared = [];
  for (const file of candidates) {
    const rel = `scripts/${file}`;
    const body = readFileSync(join(SCRIPTS, file), 'utf8');
    const writes = WRITE_PATTERNS.some((pattern) => pattern.test(body));
    const touchesDb = /DATABASE_URL|TF_RLS_APP_URL|ADMIN_URL/.test(body);
    if (!writes || !touchesDb) continue;
    if (MUST_ROUTE_THROUGH_WRAPPER.includes(rel)) continue;
    if (UNWIRED_DESTRUCTIVE_REGISTER.includes(rel)) continue;
    if (READ_ONLY_DB_SUITES.includes(rel)) continue;
    if (OPERATOR_WRITER_SCRIPTS.includes(rel)) continue;
    if (PATTERN_ONLY_FILES.includes(rel)) continue;
    if (ROLLBACK_ONLY_DB_SUITES.includes(rel)) continue;
    // Une suite invoquee uniquement via le lanceur est couverte.
    const invocations = scriptInvocations(rel);
    if (invocations.length > 0 && invocations.every(([, command]) => command.includes(WRAPPER))) continue;
    undeclared.push(rel);
  }
  undeclared.length === 0
    ? ok('toute suite ecrivant en base est soit gardee, soit declaree')
    : ko(`suites destructives non declarees : ${undeclared.join(', ')}`);
}

console.log('\n  D. le registre des suites non rattachees reste exact');
for (const rel of UNWIRED_DESTRUCTIVE_REGISTER) {
  const invocations = scriptInvocations(rel);
  invocations.length === 0
    ? ok(`${rel} — toujours rattachee a aucune commande`)
    : ko(`${rel} est desormais invoquee par ${invocations.map(([k]) => k).join(', ')} : la retirer du registre et la router`);
}

console.log('\n  F. les outils d exploitation restent hors des chaines automatiques');

/** Commandes reellement atteignables depuis `npm test`, `npm run build` ou la CI. */
function reachableCommands() {
  const reached = new Set();
  const queue = ['test', 'build'];
  for (const name of Object.keys(scripts)) {
    if (name.startsWith('pre') || name.startsWith('post')) queue.push(name);
  }
  while (queue.length > 0) {
    const name = queue.pop();
    if (reached.has(name) || !scripts[name]) continue;
    reached.add(name);
    for (const match of scripts[name].matchAll(/npm run ([\w:-]+)/g)) queue.push(match[1]);
  }
  return reached;
}

const reached = reachableCommands();
const workflowText = [];
if (existsSync(join(ROOT, '.github', 'workflows'))) {
  for (const file of readdirSync(join(ROOT, '.github', 'workflows'))) {
    workflowText.push(readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8'));
  }
}

for (const rel of OPERATOR_WRITER_SCRIPTS) {
  if (!existsSync(join(ROOT, rel))) { ko(`outil declare introuvable : ${rel}`); continue; }

  const invocations = scriptInvocations(rel);
  // Une invocation qui porte le drapeau sans ecriture ne peut pas ecrire.
  const enEcriture = invocations.filter(([, command]) => !command.includes('--dry-run'));
  const automatiques = enEcriture.filter(([name]) => reached.has(name));
  const enCi = workflowText.some((text) => text.includes(rel.replace('scripts/', 'scripts/')));

  if (automatiques.length > 0) {
    ko(`${rel} est atteignable en ecriture depuis test/build via : ${automatiques.map(([k]) => k).join(', ')}`);
  } else if (enCi) {
    ko(`${rel} est reference par un workflow`);
  } else {
    const liste = invocations.map(([k]) => k).join(', ') || 'aucune commande npm';
    ok(`${rel} — invocation(s) : ${liste} — jamais atteignable en ecriture automatiquement`);
  }

  const body = readFileSync(join(ROOT, rel), 'utf8');
  body.includes('--dry-run') || body.includes('--appliquer')
    ? ok(`${rel} — porte un mode sans ecriture`)
    : ko(`${rel} n offre aucun mode sans ecriture`);
}

console.log('\n  E. les suites declarees sans ecriture le sont vraiment');
for (const rel of READ_ONLY_DB_SUITES) {
  if (!existsSync(join(ROOT, rel))) { ok(`${rel} — absent, rien a verifier`); continue; }
  const body = readFileSync(join(ROOT, rel), 'utf8');
  const writes = WRITE_PATTERNS.some((pattern) => pattern.test(body));
  writes
    ? ko(`${rel} est declaree en lecture seule mais contient une ecriture`)
    : ok(`${rel} — confirmee en lecture seule`);
}
for (const rel of ROLLBACK_ONLY_DB_SUITES) {
  if (!existsSync(join(ROOT, rel))) { ko(`${rel} — declaree introuvable`); continue; }
  const body = readFileSync(join(ROOT, rel), 'utf8');
  const writes = WRITE_PATTERNS.some((pattern) => pattern.test(body));
  if (!writes) { ok(`${rel} — n ecrit pas du tout`); continue; }
  const annulee = /BEGIN/.test(body) && /ROLLBACK/.test(body);
  annulee
    ? ok(`${rel} — ecriture uniquement dans une transaction annulee par ROLLBACK`)
    : ko(`${rel} ecrit sans annulation : la declaration « sans trace » est fausse`);
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Politique de routage : OK.' : `Politique de routage : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
