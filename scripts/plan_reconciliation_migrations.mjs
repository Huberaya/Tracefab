#!/usr/bin/env node
/**
 * PLAN DE RECONCILIATION DES MIGRATIONS — genere, pas recopie.
 *
 * Entree  : les faits mesures (`scripts/lib/ecarts_migrations.mjs`, lectures de
 *           production du 28/10) + le contenu reel de `prisma/migrations`.
 * Sortie  : la liste exacte des migrations ABSENTES, ANNULEES et DEJA
 *           MATERALISEES, chacune avec UNE action, et un controle qui refuse
 *           tout plan qui reecrirait l'historique Prisma.
 *
 * Ce que ce script NE fait PAS : il ne se connecte a rien, n'applique rien,
 * n'ecrit dans aucune base. Il produit un plan, et il echoue si le plan viole
 * une des interdictions du mandat.
 *
 *   node scripts/plan_reconciliation_migrations.mjs [--markdown]
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ECARTS, CATALOGUE, HORS_BANDE } from './lib/ecarts_migrations.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const dossier = join(racine, 'prisma', 'migrations');
const markdown = process.argv.includes('--markdown');

const migrations = readdirSync(dossier, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();

const lireSql = (n) => readFileSync(join(dossier, n, 'migration.sql'), 'utf8');
const rejouable = (n) => {
  const sql = lireSql(n);
  // Une migration est NON rejouable si elle cree un objet sans garde.
  const creationsNues = [...sql.matchAll(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi)];
  const policyNues = [...sql.matchAll(/CREATE\s+POLICY\s+(?!IF\s+NOT\s+EXISTS)/gi)];
  const typeNus = [...sql.matchAll(/CREATE\s+TYPE\s+(?!IF\s+NOT\s+EXISTS)/gi)];
  return { rejouable: creationsNues.length + policyNues.length + typeNus.length === 0,
    sansGarde: [...creationsNues, ...policyNues, ...typeNus].length };
};

// --- 1. La liste exacte, par categorie ------------------------------------
const absentes = Object.keys(ECARTS).filter((n) => ECARTS[n].historique === 'ABSENTE');
const annulees = Object.keys(ECARTS).filter((n) => ECARTS[n].historique === 'ANNULEE');
const horsBande = Object.keys(HORS_BANDE);
const appliquees = migrations.filter((n) => !ECARTS[n] && !HORS_BANDE[n]);

/**
 * L'action, deduite de DEUX faits seulement : ce que l'historique dit, et ce
 * que le catalogue dit. Jamais d'inference (« la ligne est annulee donc c'est
 * absent » n'est pas une deduction valide — c'est demontre par 20261017120000).
 */
function actionDe(nom) {
  const e = ECARTS[nom];
  const c = CATALOGUE[nom];
  const r = rejouable(nom);
  const effets = e.effets[0];      // MESURE | DEDUIT | NON PROUVE
  const present = /^(DIVERGENCE|PRESENT)/.test(String(c?.statut)) || effets === 'MESURE';

  if (nom === '20261028150000_reconcile_plm_erp_sync_job_policies') {
    return { action: 'APPLIQUER SEULE', preuve: '4 politiques mesurees au lieu de 2',
      risque: 'faible et borne : additive, idempotente, gardes fail-closed ; si la base ne ressemble pas a l attendu elle REFUSE et arrete la suite (c est voulu)',
      prerequis: 'aucun (ne depend d aucune autre migration)' };
  }
  if (nom === '20261028120000_runtime_function_registry') {
    return { action: 'APPLIQUER EN PREMIER', preuve: 'table lue ABSENTE en production',
      risque: 'NON rejouable (CREATE TABLE sans IF NOT EXISTS) : un second passage casse et bloque les 5 suivantes',
      prerequis: 'releve du catalogue juste avant, et confirmation que la table est toujours absente' };
  }
  if (effets === 'MESURE' || effets === 'DEDUIT') {
    return { action: 'RESOLVE --APPLIED SUR PREUVE', preuve: e.effets[1],
      risque: 'aucun DDL rejoue ; documente un etat deja present sans le modifier',
      prerequis: 'sonde confirmant les effets au moment de l execution' };
  }
  // Effets NON PROUVES : le plan ne peut pas trancher a l avance, il porte donc
  // DEUX branches explicites, choisies par la sonde et par elle seule.
  const rejeu = r.rejouable
    ? 'rejouable : un second passage est sans effet'
    : `NON rejouable (${r.sansGarde} creation(s) sans garde) : la branche « appliquer » ne doit etre tentee qu UNE fois`;
  return {
    action: 'SONDE → APPLIED SI PRESENT, SINON APPLIQUER SEULE',
    preuve: 'effets NON PROUVES a ce jour',
    risque: rejeu,
    prerequis: 'sonde de la chaine ; la branche est choisie par la mesure, pas par defaut',
  };
}

const lignes = [...absentes, ...annulees].map((nom) => {
  const e = ECARTS[nom];
  const a = actionDe(nom);
  return { nom, historique: e.historique, effets: e.effets[0], ...a,
    dependDe: nom.startsWith('2026102812')
      ? (nom === '20261028120000_runtime_function_registry' ? ['—'] : ['20261028120000_runtime_function_registry'])
      : ['—'] };
});

// --- 2. Controles : le plan ne doit jamais reecrire l'historique ----------
const INTERDIT = [
  [/UPDATE\s+_prisma_migrations/i, 'UPDATE sur _prisma_migrations'],
  [/DELETE\s+FROM\s+_prisma_migrations/i, 'DELETE sur _prisma_migrations'],
  [/resolve\s+--rolled-back/i, 'resolve --rolled-back (ferait rejouer un fichier non rejouable)'],
  [/migrate\s+deploy(?!.*seule)/i, 'migrate deploy global'],
];

/** Controle un plan. Fonction pure : l autotest l appelle sur des plans mutés. */
function controler(ls, ms, hb) {
  const erreurs = [];
  for (const l of ls) {
    for (const [re, quoi] of INTERDIT) {
      if (re.test(`${l.action} ${l.risque}`)) erreurs.push(`${l.nom} : action interdite — ${quoi}`);
    }
    // Un resolve --applied sans sonde ni preuve nommee est une affirmation gratuite.
    if (/RESOLVE --APPLIED/.test(l.action) && !/SONDE/.test(l.action)
        && (!l.preuve || /^(aucune mesure|effets NON PROUVES)/.test(l.preuve))) {
      erreurs.push(`${l.nom} : resolve --applied sans preuve nommee`);
    }
    if (!ms.includes(l.nom)) erreurs.push(`${l.nom} : cite mais absent du depot`);
  }
  for (const n of hb) if (!ms.includes(n)) erreurs.push(`${n} : hors bande absent du depot`);
  const ordre = ls.map((l) => l.nom);
  const iReg = ordre.indexOf('20261028120000_runtime_function_registry');
  const i120 = ordre.indexOf('20261028120100_worker_identity_not_forgeable');
  if (iReg >= 0 && i120 >= 0 && iReg > i120) {
    erreurs.push('ordre : le registre doit preceder 20261028120100');
  }
  // Fermeture : chaque migration du depot dans exactement une categorie.
  return erreurs;
}

function fermeture(ms, categories) {
  const vues = new Map();
  for (const c of categories) for (const n of c) vues.set(n, (vues.get(n) ?? 0) + 1);
  const err = [];
  for (const n of ms) {
    const k = vues.get(n) ?? 0;
    if (k === 0) err.push(`${n} : dans aucune categorie`);
    if (k > 1) err.push(`${n} : dans ${k} categories`);
  }
  for (const n of vues.keys()) if (!ms.includes(n)) err.push(`${n} : categorie citee, absente du depot`);
  return err;
}

const erreurs = [...controler(lignes, migrations, horsBande),
                 ...fermeture(migrations, [absentes, annulees, horsBande, appliquees])];

// --- 2 bis. Autotest : les controles savent-ils ECHOUER ? ----------------
// Sans cela, « aucune violation » ne prouve rien : un detecteur casse rend le
// meme silence qu un plan correct.
if (process.argv.includes('--autotest')) {
  const temoins = [
    ['UPDATE sur _prisma_migrations',
      (l) => { l[0] = { ...l[0], action: 'UPDATE _prisma_migrations SET finished_at = now()' }; }],
    ['DELETE sur _prisma_migrations',
      (l) => { l[0] = { ...l[0], action: 'DELETE FROM _prisma_migrations' }; }],
    ['resolve --rolled-back',
      (l) => { l[0] = { ...l[0], action: 'resolve --rolled-back' }; }],
    ['deploy global',
      (l) => { l[0] = { ...l[0], action: 'migrate deploy' }; }],
    ['resolve --applied sans preuve',
      (l) => { l[0] = { ...l[0], action: 'RESOLVE --APPLIED SUR PREUVE', preuve: 'effets NON PROUVES' }; }],
    ['ordre inverse (registre apres 120100)',
      (l) => { const i = l.findIndex((x) => x.nom.startsWith('20261028120000'));
               const j = l.findIndex((x) => x.nom.startsWith('20261028120100'));
               if (i >= 0 && j >= 0) { const t = l[i]; l[i] = l[j]; l[j] = t; } }],
  ];
  let vus = 0;
  for (const [libelle, muter] of temoins) {
    const copie = lignes.map((l) => ({ ...l }));
    muter(copie);
    if (controler(copie, migrations, horsBande).length > 0) { vus += 1; console.log(`  temoin detecte : ${libelle}`); }
    else console.error(`  TEMOIN NON DETECTE : ${libelle} — le controle est aveugle`);
  }
  const f = fermeture(migrations, [absentes.slice(1), annulees, horsBande, appliquees]);
  if (f.length > 0) { vus += 1; console.log('  temoin detecte : migration hors de toute categorie'); }
  else console.error('  TEMOIN NON DETECTE : fermeture des categories');
  const attendus = temoins.length + 1;
  console.log(erreurs.length === 0 && vus === attendus
    ? `autotest : ${vus}/${attendus} temoins detectes, plan reel sans violation.`
    : `autotest ECHEC : ${vus}/${attendus} temoins, ${erreurs.length} violation(s) reelle(s).`);
  process.exit(erreurs.length === 0 && vus === attendus ? 0 : 1);
}

// --- 3. Sortie ------------------------------------------------------------
if (markdown) {
  console.log('# Plan de reconciliation des migrations — genere\n');
  console.log(`\`node scripts/plan_reconciliation_migrations.mjs --markdown\` sur ${migrations.length} migrations du depot.\n`);
  console.log('**Aucune etape de ce plan n a ete executee.** Aucun acces en ecriture a la production.\n');
  console.log('## 1. Liste exacte\n');
  console.log('| Migration | Historique | Effets (production) | Action | Prerequis | Risque |');
  console.log('|---|---|---|---|---|---|');
  for (const l of lignes) {
    console.log(`| \`${l.nom}\` | ${l.historique} | ${l.effets} | **${l.action}** | ${l.prerequis} | ${l.risque} |`);
  }
  console.log('\n## 2. Deja materialisees (5) — ne rien rejouer\n');
  console.log('| Migration | Objets lus presents |');
  console.log('|---|---|');
  for (const n of horsBande) console.log(`| \`${n}\` | ${HORS_BANDE[n].join(', ')} |`);
  console.log('\n## 3. Interdits du plan, verifies\n');
  console.log('Le generateur refuse : `UPDATE`/`DELETE` sur `_prisma_migrations`,');
  console.log('`resolve --rolled-back`, `deploy` global, `resolve --applied` sans preuve nommee.');
  console.log('`resolve --applied` n ecrit aucune ligne de migration : il documente un etat deja la.\n');
  console.log(`Controles : ${erreurs.length === 0 ? 'aucune violation' : erreurs.join(' ; ')}`);
} else {
  console.log(`migrations du depot : ${migrations.length}`);
  console.log(`  appliquees (attestees) : ${appliquees.length}`);
  console.log(`  appliquees hors bande  : ${horsBande.length}`);
  console.log(`  annulees              : ${annulees.length}  ${JSON.stringify(annulees)}`);
  console.log(`  absentes              : ${absentes.length}  ${JSON.stringify(absentes)}`);
  console.log('');
  for (const l of lignes) {
    console.log(`  ${l.nom}`);
    console.log(`    historique=${l.historique} effets=${l.effets} -> ${l.action}`);
    console.log(`    preuve : ${l.preuve}`);
    console.log(`    risque : ${l.risque}`);
  }
  console.log('');
  for (const e of erreurs) console.log(`  VIOLATION ${e}`);
  console.log(erreurs.length === 0
    ? 'Le plan est coherent : 11 ecarts repartis, aucune action ne reecrit l historique.'
    : `${erreurs.length} violation(s) du plan.`);
}

process.exit(erreurs.length === 0 ? 0 : 1);
