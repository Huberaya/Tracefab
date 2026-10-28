#!/usr/bin/env node
/**
 * Reconciliation, HORS LIGNE, entre l'historique de migrations lu en production
 * et les migrations presentes dans ce depot.
 *
 * POURQUOI CET OUTIL EXISTE
 *
 * Le 28 octobre 2026, trois constats ont ete rapportes sur la base de
 * production : le proprietaire contourne la RLS, `_prisma_migrations` contient
 * des entrees non terminees et annulees, et la table
 * `tracefab_runtime_function_registry` est absente alors que la branche
 * candidate la cree. Ces trois constats se tiennent ou tombent ensemble, et
 * aucun ne se lit dans un nom de branche.
 *
 * La question qui decide de tout est simple et n'exige AUCUNE connexion :
 * pour chaque migration du depot, la production atteste-t-elle l'avoir
 * executee, et l'a-t-elle executee avec CE contenu ?
 *
 * Prisma calcule le `checksum` d'une migration comme le SHA-256 hexadecimal du
 * contenu de son fichier `migration.sql` (verifie dans le paquet installe :
 * `node_modules/prisma/build/index.js`, fonction de hachage en flux, digest
 * "hex"). Ce script recalcule les 63 empreintes du depot et les compare a
 * celles exportees de la production. Une empreinte qui differe pour un meme
 * nom de migration signifie que le fichier a change depuis l'execution
 * distante — c'est le cas des migrations corrigees apres un incident (P3018
 * du 15 octobre 2026 sur `tracefab_public_brand`).
 *
 * POURQUOI PAS UNE CONNEXION
 *
 * Cet outil ne se connecte a rien. Il ne lit aucune variable d'environnement,
 * aucune URL, aucun secret. L'operateur exporte le resultat du bloc de lecture
 * seule de `docs/security/2026-10-28-m6-lecture-seule.sql` (colonnes
 * `migration_name`, `checksum`, `finished_at`, `rolled_back_at`,
 * `applied_steps_count`) dans un fichier, et le passe ici. Rien de ce que
 * manipule cet outil n'est sensible : des noms de migration et des empreintes.
 *
 * USAGE
 *
 *   node scripts/reconcilier-historique-migrations.mjs <export>
 *   node scripts/reconcilier-historique-migrations.mjs --sans-export
 *
 * `--sans-export` n'imprime que les empreintes attendues du depot : utile pour
 * prepare une comparaison a la main.
 *
 * FORMAT ACCEPTE pour <export> : tout texte ou chaque ligne utile contient un
 * nom de migration (`20261017120000_active_tenant_context`) et, s'il est
 * present, une empreinte SHA-256 de 64 caracteres hexadecimaux. CSV, TSV,
 * sorties `psql` avec separateur `|` et JSON sont acceptes : le parseur ne
 * suppose ni separateur ni ordre de colonnes, il lit ce qu'il reconnait.
 *
 * CODES DE SORTIE
 *
 *   0  historique coherent : toutes les migrations du depot sont attestees
 *      terminees, sans divergence d'empreinte, et aucune entree en echec.
 *   1  ecart detecte (migration manquante, non terminee, annulee, divergente,
 *      ou entree orpheline dans l'historique distant).
 *   2  entree illisible : argument absent ou export vide.
 *
 * L'outil ne modifie rien, ni localement ni a distance.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
const DOSSIER = join(RACINE, 'prisma', 'migrations');

/* --- 1. Empreintes attendues, calculees depuis le depot ------------------- */

export function empreintesDepot() {
  const attendues = new Map();
  for (const d of readdirSync(DOSSIER).filter((x) => /^\d{14}_/.test(x)).sort()) {
    const f = join(DOSSIER, d, 'migration.sql');
    if (!existsSync(f)) continue;
    attendues.set(d, createHash('sha256').update(readFileSync(f)).digest('hex'));
  }
  return attendues;
}

/* --- 2. Lecture de l'export ---------------------------------------------- */

const NOM = /\b(\d{14}_[a-z0-9_]+)\b/g;
const EMPREINTE = /\b([0-9a-f]{64})\b/gi;
const VIDE = new Set(['', 'null', '\\n', '-', 'na', 'n/a']);

/** Decoupe une ligne CSV/TSV en respectant les guillemets. */
function decouper(ligne, sep) {
  const champs = [];
  let courant = '';
  let entreGuillemets = false;
  for (let i = 0; i < ligne.length; i += 1) {
    const c = ligne[i];
    if (entreGuillemets) {
      if (c === '"' && ligne[i + 1] === '"') { courant += '"'; i += 1; }
      else if (c === '"') entreGuillemets = false;
      else courant += c;
    } else if (c === '"') entreGuillemets = true;
    else if (c === sep) { champs.push(courant); courant = ''; }
    else courant += c;
  }
  champs.push(courant);
  return champs.map((x) => x.trim());
}

function delimiterDe(entete) {
  const candidats = [',', '\t', '|'];
  let meilleur = null;
  let compte = 0;
  for (const c of candidats) {
    const n = entete.split(c).length - 1;
    if (n > compte) { compte = n; meilleur = c; }
  }
  return meilleur;
}

/**
 * Lit l'export. Deux formes acceptees :
 *
 *   a) AVEC EN-TETE (recommande) — la premiere ligne nomme les colonnes
 *      (`migration_name`, `checksum`, `finished_at`, `rolled_back_at`,
 *      `applied_steps_count`). Les etats sont alors connus.
 *   b) SANS EN-TETE — seuls les noms et les empreintes sont reconnus. Les
 *      etats (terminee / annulee) restent INCONNUS : l'outil le dira, il ne
 *      supposera pas « terminee » par silence.
 */
export function lireExport(texte) {
  const lignes = texte.split(/\r?\n/).filter((l) => l.trim() !== '');
  const entete = lignes.find((l) => /migration_name/i.test(l) && /checksum/i.test(l));

  if (entete) {
    const sep = delimiterDe(entete);
    if (!sep) return { entrees: new Map(), etatsConnus: false };
    const colonnes = decouper(entete, sep).map((c) => c.toLowerCase());
    const idx = (nom) => colonnes.indexOf(nom);
    const iNom = idx('migration_name');
    if (iNom === -1) return { entrees: new Map(), etatsConnus: false };

    const entrees = new Map();
    for (const ligne of lignes) {
      if (ligne === entete) continue;
      const champs = decouper(ligne, sep);
      const nom = (champs[iNom] || '').trim();
      if (!/^\d{14}_[a-z0-9_]+$/.test(nom)) continue;
      const lire = (colonne) => {
        const i = idx(colonne);
        if (i === -1) return null;
        const v = (champs[i] || '').trim().toLowerCase();
        return VIDE.has(v) ? null : champs[i].trim();
      };
      entrees.set(nom, {
        nom,
        checksum: (lire('checksum') || '').toLowerCase() || null,
        finished_at: lire('finished_at'),
        rolled_back_at: lire('rolled_back_at'),
        applied_steps_count: lire('applied_steps_count'),
      });
    }
    return { entrees, etatsConnus: true };
  }

  // Repli sans en-tete : noms et empreintes seulement.
  const entrees = new Map();
  for (const ligne of lignes) {
    const nom = [...ligne.matchAll(NOM)].map((m) => m[1])[0];
    if (!nom) continue;
    const empreinte = [...ligne.matchAll(EMPREINTE)].map((m) => m[1].toLowerCase())[0] || null;
    const entree = entrees.get(nom) || { nom, checksum: null, finished_at: null, rolled_back_at: null };
    if (!entree.checksum && empreinte) entree.checksum = empreinte;
    entrees.set(nom, entree);
  }
  return { entrees, etatsConnus: false };
}

/* --- 4. Comparaison ------------------------------------------------------ */

export function reconcilier(texteExport) {
  const attendues = empreintesDepot();
  const { entrees: lues, etatsConnus } = lireExport(texteExport);

  const absentes = [];      // au depot, pas dans l'historique distant
  const divergentes = [];   // meme nom, empreinte differente
  const orphelines = [];    // dans l'historique distant, absentes du depot

  for (const [nom, empreinte] of attendues) {
    if (!lues.has(nom)) { absentes.push(nom); continue; }
    const lue = lues.get(nom).checksum;
    if (lue && lue !== empreinte) divergentes.push({ nom, attendue: empreinte, lue });
  }
  for (const nom of lues.keys()) if (!attendues.has(nom)) orphelines.push(nom);

  const nonTerminees = [...lues.values()]
    .filter((e) => attendues.has(e.nom) && e.rolled_back_at === null && e.finished_at === null)
    .map((e) => e.nom);
  const annuleesConnues = [...lues.values()]
    .filter((e) => attendues.has(e.nom) && e.rolled_back_at !== null)
    .map((e) => e.nom);

  return {
    depot: attendues.size,
    attestees: attendues.size - absentes.length,
    absentes,
    divergentes,
    orphelines,
    nonTerminees,
    annulees: annuleesConnues,
    etatsConnus,
    coherent:
      etatsConnus
      && absentes.length === 0 && divergentes.length === 0 && orphelines.length === 0
      && nonTerminees.length === 0 && annuleesConnues.length === 0,
  };
}

/* --- 5. Sortie ------------------------------------------------------------ */

function principal() {
  const arg = process.argv[2];

  if (arg === '--sans-export') {
    const attendues = empreintesDepot();
    console.log(`\n  ${attendues.size} migrations au depot, empreintes recalculees :\n`);
    for (const [nom, e] of attendues) console.log(`  ${e}  ${nom}`);
    console.log('\n  Aucune connexion ouverte. Aucun fichier ecrit.\n');
    process.exit(0);
  }

  if (!arg) {
    console.error('usage : node scripts/reconcilier-historique-migrations.mjs <export> | --sans-export');
    process.exit(2);
  }
  const chemin = arg;
  if (!existsSync(chemin)) {
    console.error(`  export introuvable : ${chemin}`);
    process.exit(2);
  }
  const texte = readFileSync(chemin, 'utf8');
  if (texte.trim() === '') {
    console.error('  export vide : aucune ligne a comparer.');
    process.exit(2);
  }

  const r = reconcilier(texte);

  console.log(`\n  depot                          : ${r.depot} migrations`);
  console.log(`  attestees par la production     : ${r.attestees}`);
  console.log(`  presentes, empreinte identique  : ${r.attestees - r.divergentes.length}`);

  const bloc = (titre, liste, note) => {
    if (liste.length === 0) return;
    console.log(`\n  ${titre} (${liste.length})`);
    for (const l of liste) console.log(`    - ${typeof l === 'string' ? l : l.nom}`);
    if (note) console.log(`      ${note}`);
  };

  bloc('NON ATTESTEES : au depot, jamais executees en production', r.absentes,
    'Ces migrations n\'ont pas de ligne dans l\'historique distant.');
  bloc('EMPREINTE DIVERGENTE : meme nom, contenu different', r.divergentes,
    'Le fichier a change depuis l\'execution distante. Re-executer ne remplace pas ce qui a ete joue.');
  if (!r.etatsConnus) {
    console.log('\n  ETATS INCONNUS : l\'export n\'a pas d\'en-tete de colonnes.');
    console.log('    Les migrations presentes sont donc seulement « attestees », pas');
    console.log('    « terminees ». Reexporter avec les colonnes finished_at et');
    console.log('    rolled_back_at pour conclure sur les echecs.');
  }
  bloc('NON TERMINEES : `finished_at` absent', r.nonTerminees,
    'Une migration non terminee bloque `prisma migrate deploy` tant qu\'elle n\'est pas resolue.');
  bloc('ANNULEES : `rolled_back_at` renseigne', r.annulees);
  bloc('ORPHELINES : dans l\'historique distant, absentes du depot', r.orphelines);

  if (r.divergentes.length > 0) {
    console.log('\n  Detail des divergences :');
    for (const d of r.divergentes) {
      console.log(`    ${d.nom}`);
      console.log(`      depot        ${d.attendue}`);
      console.log(`      production   ${d.lue}`);
    }
  }

  console.log('\n  --------------------------------------------');
  if (r.coherent) {
    console.log('  Historique coherent : aucune action requise.');
    process.exit(0);
  }
  console.log('  ECART DETECTE.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) principal();
