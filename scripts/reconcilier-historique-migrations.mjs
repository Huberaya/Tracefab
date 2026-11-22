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
 * candidate la cree.
 *
 * La question qui decide de tout n'exige AUCUNE connexion : pour chaque
 * migration du depot, la production atteste-t-elle l'avoir executee, et l'a-t-
 * elle executee avec CE contenu ?
 *
 * Prisma calcule le `checksum` d'une migration comme le SHA-256 hexadecimal du
 * contenu de son fichier `migration.sql` (verifie dans le paquet installe :
 * `node_modules/prisma/build/index.js`, hachage en flux, digest "hex"). Ce
 * script recalcule les 63 empreintes du depot et les compare aux lignes
 * exportees de la production.
 *
 * UNE MIGRATION PEUT AVOIR PLUSIEURS LIGNES
 *
 * `_prisma_migrations` n'a pas de contrainte d'unicite sur `migration_name` :
 * une migration echouee puis `resolve --rolled-back` puis rejouee laisse DEUX
 * lignes — une annulee, une terminee. Ecraser les doublons dans une table de
 * hachage effacerait precisement l'information la plus utile. Cet outil garde
 * donc toutes les lignes d'un meme nom et les classe :
 *
 *   - ATTESTEE     : au moins une ligne terminee (`finished_at` non NULL) ;
 *   - BLOQUANTE    : une ligne ni terminee ni annulee — `migrate deploy`
 *                    s'arrete la ;
 *   - ANNULEE      : une ligne `rolled_back_at` non NULL — trace d'un incident
 *                    resolu SI une execution ulterieure a abouti, sinon
 *                    incident ouvert ;
 *   - DIVERGENTE   : l'empreinte de la ligne retenue par Prisma differe de
 *                    celle du depot — le fichier a change depuis l'execution.
 *
 * POURQUOI PAS UNE CONNEXION
 *
 * Cet outil ne se connecte a rien. Il ne lit aucune variable d'environnement,
 * aucune URL, aucun secret. L'operateur exporte le resultat d'un SELECT en
 * lecture seule (voir docs/security/2026-10-28-m6-lecture-seule.sql) et le
 * passe ici. Rien de ce que manipule cet outil n'est sensible : des noms de
 * migration, des empreintes, des horodatages.
 *
 * USAGE
 *
 *   node scripts/reconcilier-historique-migrations.mjs <export>
 *   node scripts/reconcilier-historique-migrations.mjs --sans-export
 *
 * FORMAT ACCEPTE pour <export> : JSON (objet ou tableau), CSV/TSV avec en-tete,
 * ou sortie `psql`. Le parseur ne suppose ni separateur ni ordre de colonnes.
 *
 * CODES DE SORTIE
 *
 *   0  historique coherent : toutes les migrations du depot sont attestees,
 *      aucun blocage, aucune divergence sur la ligne retenue.
 *   1  ecart detecte.
 *   2  entree illisible : argument absent ou export vide.
 *
 * L'outil ne modifie rien, ni localement ni a distance.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
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

const vide = (v) => v === null || v === undefined || VIDE.has(String(v).trim().toLowerCase());

/** Normalise une ligne brute, quelle que soit son origine. */
function ligne(nom, checksum, finished, rolledBack, steps) {
  return {
    nom,
    checksum: vide(checksum) ? null : String(checksum).trim().toLowerCase(),
    finished_at: vide(finished) ? null : String(finished).trim(),
    rolled_back_at: vide(rolledBack) ? null : String(rolledBack).trim(),
    applied_steps_count: vide(steps) ? null : Number(steps),
  };
}

function decouperCsv(ligneBrute, sep) {
  const champs = [];
  let courant = '';
  let entreGuillemets = false;
  for (let i = 0; i < ligneBrute.length; i += 1) {
    const c = ligneBrute[i];
    if (entreGuillemets) {
      if (c === '"' && ligneBrute[i + 1] === '"') { courant += '"'; i += 1; }
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
  let meilleur = null;
  let compte = 0;
  for (const c of [',', '\t', '|']) {
    const n = entete.split(c).length - 1;
    if (n > compte) { compte = n; meilleur = c; }
  }
  return meilleur;
}

const ajouter = (index, l) => {
  if (!index.has(l.nom)) index.set(l.nom, []);
  index.get(l.nom).push(l);
};

function lireJson(texte) {
  let donnees;
  try { donnees = JSON.parse(texte); } catch { return null; }
  const brut = Array.isArray(donnees) ? donnees : [donnees];
  if (brut.length === 0) return null;
  const premier = brut[0];
  if (typeof premier !== 'object' || premier === null) return null;
  // Un JSON sans les colonnes attendues n'est pas un export d'historique.
  if (!('migration_name' in premier) && !('migrationName' in premier)) return null;

  const index = new Map();
  for (const r of brut) {
    const nom = r.migration_name ?? r.migrationName;
    if (!nom) continue;
    ajouter(index, ligne(nom, r.checksum, r.finished_at ?? r.finishedAt,
      r.rolled_back_at ?? r.rolledBackAt, r.applied_steps_count ?? r.appliedStepsCount));
  }
  return { lignes: index, etatsConnus: true, format: 'JSON' };
}

function lireTableau(texte) {
  const brutes = texte.split(/\r?\n/).filter((l) => l.trim() !== '');
  const entete = brutes.find((l) => /migration_name/i.test(l) && /checksum/i.test(l));

  if (entete) {
    const sep = delimiterDe(entete);
    if (!sep) return null;
    const colonnes = decouperCsv(entete, sep).map((c) => c.toLowerCase());
    const idx = (nom) => colonnes.indexOf(nom);
    const iNom = idx('migration_name');
    if (iNom === -1) return null;

    const index = new Map();
    for (const l of brutes) {
      if (l === entete) continue;
      const champs = decouperCsv(l, sep);
      const nom = (champs[iNom] || '').trim();
      if (!/^\d{14}_[a-z0-9_]+$/.test(nom)) continue;
      const champ = (c) => { const i = idx(c); return i === -1 ? null : champs[i]; };
      ajouter(index, ligne(nom, champ('checksum'), champ('finished_at'),
        champ('rolled_back_at'), champ('applied_steps_count')));
    }
    return { lignes: index, etatsConnus: true, format: 'CSV avec en-tete' };
  }

  // Repli sans en-tete : noms et empreintes seulement, une ligne = une entree.
  const index = new Map();
  let trouve = false;
  for (const l of brutes) {
    const nom = [...l.matchAll(NOM)].map((m) => m[1])[0];
    if (!nom) continue;
    trouve = true;
    const e = [...l.matchAll(EMPREINTE)].map((m) => m[1].toLowerCase())[0] || null;
    ajouter(index, ligne(nom, e, null, null, null));
  }
  return trouve ? { lignes: index, etatsConnus: false, format: 'sans en-tete' } : null;
}

export function lireExport(texte) {
  return lireJson(texte) || lireTableau(texte) || { lignes: new Map(), etatsConnus: false, format: 'inconnu' };
}

/* --- 2 bis. Lanceurs maison : qui d'autre a pu appliquer une migration ? --- */

/**
 * Le depot contient des scripts qui executent un `migration.sql` SANS passer
 * par `prisma migrate deploy` (famille `apply_migration_chantier*.mjs`). Ils
 * n'ecrivent pas `_prisma_migrations` : la ligne d'historique a donc ete posee
 * autrement, typiquement par un `resolve --applied`, ce qui explique un
 * `applied_steps_count = 0`.
 *
 * Cette correlation change la lecture d'un 0 etape : ce n'est pas forcement
 * « rien n'a ete execute », c'est souvent « execute par un autre chemin ».
 * Les deux hypotheses n'ont pas les memes consequences, donc l'outil les
 * separe au lieu de les confondre.
 */
export function lanceursMaison() {
  const scripts = join(RACINE, 'scripts');
  const trouves = new Map();
  if (!existsSync(scripts)) return trouves;
  for (const f of readdirSync(scripts)) {
    if (!/\.(mjs|js|cjs)$/.test(f)) continue;
    const brut = readFileSync(join(scripts, f), 'utf8');
    for (const m of brut.matchAll(/(\d{14}_[a-z0-9_]+)\//g)) {
      const nom = m[1];
      if (!trouves.has(nom)) trouves.set(nom, []);
      if (!trouves.get(nom).includes(f)) trouves.get(nom).push(f);
    }
  }
  return trouves;
}

/* --- 3. Provenance : a quel commit cette comparaison se rapporte ---------- */

export function provenance() {
  const git = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  };
  const sha = git('git rev-parse HEAD');
  const statut = git('git status --porcelain');
  return {
    sha,
    arbrePropre: statut !== null && statut === '',
    modifications: statut ? statut.split('\n').filter(Boolean).length : null,
  };
}

/* --- 4. Comparaison ------------------------------------------------------ */

/** La ligne que Prisma considere comme l'execution courante. */
const retenue = (lignes) =>
  lignes.find((l) => l.finished_at !== null && l.rolled_back_at === null)
  || lignes.find((l) => l.finished_at !== null)
  || null;

export function reconcilier(texteExport) {
  const attendues = empreintesDepot();
  const { lignes: index, etatsConnus, format } = lireExport(texteExport);

  const absentes = [];
  const divergentes = [];
  const bloquees = [];
  const annuleesOuvertes = [];
  const annuleesResolues = [];
  const doublons = [];
  const sansEtape = [];
  let attestees = 0;

  for (const [nom, empreinte] of attendues) {
    const lignes = index.get(nom);
    if (!lignes) { absentes.push(nom); continue; }

    if (lignes.length > 1) doublons.push({ nom, lignes });

    const courante = retenue(lignes);
    if (courante) {
      attestees += 1;
      if (courante.checksum && courante.checksum !== empreinte) {
        divergentes.push({ nom, attendue: empreinte, lue: courante.checksum });
      }
      if (courante.applied_steps_count === 0) sansEtape.push(nom);
    }

    for (const l of lignes) {
      const niTermineeNiAnnulee = l.finished_at === null && l.rolled_back_at === null;
      const annulee = l.rolled_back_at !== null;
      if (niTermineeNiAnnulee) { bloquees.push({ nom, l }); continue; }
      if (annulee) {
        // Une annulation suivie d'une reussite est une trace d'incident resolu.
        // Une annulation sans reussite ulterieure laisse la migration non
        // appliquee : `deploy` la rejouera, ce qui n'est pas un blocage.
        if (retenue(lignes)) annuleesResolues.push({ nom, l });
        else annuleesOuvertes.push({ nom, l });
      }
    }
  }

  const orphelines = [];
  for (const [nom, lignes] of index) {
    if (!attendues.has(nom)) orphelines.push({ nom, lignes });
  }

  // Un 0 etape s'explique de deux facons tres differentes selon qu'un lanceur
  // maison execute cette migration ou non.
  const lanceurs = lanceursMaison();
  const sansEtapeAvecLanceur = sansEtape.filter((n) => lanceurs.has(n))
    .map((n) => ({ nom: n, lanceurs: lanceurs.get(n) }));
  const sansEtapeSansLanceur = sansEtape.filter((n) => !lanceurs.has(n));

  return {
    depot: attendues.size,
    lignesLues: [...index.values()].reduce((n, l) => n + l.length, 0),
    nomsLus: index.size,
    format,
    attestees,
    absentes,
    divergentes,
    bloquees,
    annuleesResolues,
    annuleesOuvertes,
    doublons,
    sansEtape,
    sansEtapeAvecLanceur,
    sansEtapeSansLanceur,
    orphelines,
    etatsConnus,
    coherent:
      etatsConnus
      && absentes.length === 0 && divergentes.length === 0 && bloquees.length === 0
      && annuleesOuvertes.length === 0 && orphelines.length === 0
      && sansEtapeSansLanceur.length === 0,
  };
}

/* --- 5. Sortie ------------------------------------------------------------ */

const nomDate = (n) => n.slice(0, 14);

function principal() {
  const arg = process.argv[2];
  const p = provenance();
  console.log(`\n  commit           : ${p.sha || 'inconnu (pas un depot git)'}`);
  if (!p.arbrePropre) {
    console.log(`  ARBRE MODIFIE    : ${p.modifications} fichier(s) — les empreintes ne sont pas`);
    console.log('                     reproductibles depuis le commit seul.');
  }

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
  if (!existsSync(arg)) {
    console.error(`  export introuvable : ${arg}`);
    process.exit(2);
  }
  const texte = readFileSync(arg, 'utf8');
  if (texte.trim() === '') {
    console.error('  export vide : aucune ligne a comparer.');
    process.exit(2);
  }

  const r = reconcilier(texte);
  if (r.nomsLus === 0) {
    console.error('  aucun nom de migration reconnu dans l export : rien a comparer.');
    process.exit(2);
  }

  console.log(`  format           : ${r.format}`);
  console.log(`  depot            : ${r.depot} migrations`);
  console.log(`  production       : ${r.lignesLues} ligne(s) d historique, ${r.nomsLus} nom(s) distinct(s)`);
  console.log(`  attestees        : ${r.attestees} / ${r.depot}`);

  const bloc = (titre, items, rendu, note) => {
    if (items.length === 0) return;
    console.log(`\n  ${titre} (${items.length})`);
    for (const i of items) console.log(`    - ${rendu(i)}`);
    if (note) console.log(`      ${note}`);
  };

  bloc('NON ATTESTEES : au depot, aucune execution reussie en production',
    r.absentes, (n) => n,
    'Absentes de l historique : `migrate deploy` tentera de les appliquer.');
  bloc('BLOQUANTES : ni terminees ni annulees', r.bloquees,
    (b) => `${b.nom}  (commencee ${b.l.started_at || '?'})`,
    '`migrate deploy` s arrete ici. Aucune n etait signalee si la liste est vide.');
  bloc('DIVERGENTES : la ligne retenue ne correspond pas au depot', r.divergentes,
    (d) => `${d.nom}\n        depot      ${d.attendue}\n        production ${d.lue}`,
    'Le fichier a change depuis l execution distante.');
  bloc('ANNULEES SANS REUSSITE ULTERIEURE', r.annuleesOuvertes,
    (a) => `${a.nom}  (annulee ${a.l.rolled_back_at})`,
    '`deploy` rejouera ces migrations.');
  bloc('ANNULEES PUIS REUSSIES (incident resolu)', r.annuleesResolues,
    (a) => `${a.nom}  (annulee ${a.l.rolled_back_at}, puis reussie)`,
    'Trace d incident : rien a faire, mais la ligne reste dans l historique.');
  bloc('NOMS EN DOUBLE : plusieurs lignes pour une migration', r.doublons,
    (d) => `${d.nom}  (${d.lignes.length} lignes : ${d.lignes.map((l) => (l.rolled_back_at ? 'annulee' : l.finished_at ? 'terminee' : 'en cours')).join(', ')})`,
    'Normal apres un resolve suivi d un rejeu — anormal si les lignes se contredisent.');
  bloc('APPLIQUEES HORS BANDE : 0 etape, mais un lanceur du depot existe',
    r.sansEtapeAvecLanceur,
    (x) => `${x.nom}  (execute par ${x.lanceurs.join(', ')})`,
    'Executees sans `prisma migrate deploy`, puis enregistrees comme appliquees. '
    + 'Le schema peut differer de ce que produirait la migration : a verifier objet par objet.');
  bloc('MARQUEES APPLIQUEES SANS AUCUNE ETAPE ET SANS EXECUTEUR CONNU',
    r.sansEtapeSansLanceur, (n) => n,
    'Rien dans le depot n explique l application : les objets peuvent manquer.');
  bloc('ORPHELINES : en production, absentes du depot', r.orphelines,
    (o) => o.nom);

  if (!r.etatsConnus) {
    console.log('\n  ETATS INCONNUS : l export n a pas de colonnes d etat.');
    console.log('    Les migrations presentes sont « attestees », pas « terminees ».');
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
