#!/usr/bin/env node
/**
 * Comparaison de deux cibles PostgreSQL — sans jamais les afficher.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Il faut savoir si `DATABASE_URL` (ce que l'application emploie) et
 * `TF_RLS_APP_URL` (la même base vue par le rôle restreint `tracefab_app`)
 * désignent la même instance, sans pour autant manipuler ni transcrire des
 * chaînes portant des identifiants.
 *
 * CE QUE CE SCRIPT NE FAIT PAS
 *
 *   - aucune connexion : `pg` n'est pas importé, aucun socket n'est ouvert ;
 *   - aucune requête SQL, aucune écriture, aucune lecture de fichier ;
 *   - aucun affichage des chaînes complètes, ni du mot de passe.
 *
 * Seuls l'hôte, le port, le nom de base, l'utilisateur, le `sslmode` et une
 * empreinte SHA-256 tronquée sont imprimés. L'empreinte permet de reconnaître
 * une valeur déjà vue sans la révéler.
 *
 * Un garde-fou vérifie avant chaque impression que le texte ne contient ni la
 * chaîne brute, ni le mot de passe, ni aucun fragment de 8 caractères de ce
 * dernier. En cas de fuite détectée le script s'arrête au lieu d'imprimer.
 *
 * Sorties : 0 cibles identiques · 1 cibles différentes · 2 variable absente ou
 * illisible · 3 fuite détectée et impression refusée.
 */
import { createHash } from 'node:crypto';

const SORTIE_IDENTIQUE = 0;
const SORTIE_DIFFERENT = 1;
const SORTIE_ABSENTE = 2;
const SORTIE_FUITE = 3;

const VARIABLES = ['DATABASE_URL', 'TF_RLS_APP_URL'];

/* --- Garde-fou : rien de sensible ne sort ---------------------------------- */

// Deux niveaux, et la distinction est essentielle :
//
//   EXACTS    — la chaîne brute entière. Interdite telle quelle, mais pas par
//               fragments : l'hôte et le nom de base en font partie, et ce
//               sont justement les éléments demandés en sortie.
//   FRAGMENTS — le mot de passe seul, décliné en fenêtres de 8 caractères.
//               Une divulgation partielle d'un identifiant reste une fuite.
//
// Confondre les deux rend l'outil inutilisable : interdire tout fragment de 8
// caractères de la chaîne complète interdirait aussi d'imprimer l'hôte.
const INTERDITS_EXACTS = new Set();
const INTERDITS_FRAGMENTS = new Set();

function interdireExact(valeur) {
  if (typeof valeur === 'string' && valeur.length > 0) INTERDITS_EXACTS.add(valeur);
}

function interdireFragments(valeur) {
  // En dessous de 8 caractères, la protection par sous-chaîne est inutilisable :
  // interdire « p » interdirait toute ligne contenant la lettre p. La chaîne de
  // connexion complète reste de toute façon interdite telle quelle par
  // interdireExact, et le mot de passe n'est jamais un champ imprimé.
  if (typeof valeur !== 'string' || valeur.length < 8) return;
  INTERDITS_FRAGMENTS.add(valeur);
  for (let i = 0; i + 8 <= valeur.length; i += 1) INTERDITS_FRAGMENTS.add(valeur.slice(i, i + 8));
}

function publier(ligne) {
  for (const interdit of INTERDITS_EXACTS) {
    if (ligne.includes(interdit)) {
      process.stdout.write(
        '\n  REFUS — le texte à imprimer contenait une chaîne de connexion brute. Rien n\'a été affiché.\n',
      );
      process.exit(SORTIE_FUITE);
    }
  }
  for (const interdit of INTERDITS_FRAGMENTS) {
    if (interdit && ligne.includes(interdit)) {
      process.stdout.write(
        '\n  REFUS — le texte à imprimer contenait un fragment d\'identifiant. Rien n\'a été affiché.\n',
      );
      process.exit(SORTIE_FUITE);
    }
  }
  process.stdout.write(`${ligne}\n`);
}

/* --- Lecture et analyse ---------------------------------------------------- */

function empreinte(valeur) {
  return createHash('sha256').update(valeur).digest('hex').slice(0, 16);
}

function analyser(nom, brute) {
  interdireExact(brute);

  if (!brute || !brute.trim()) {
    return { nom, present: false, raison: 'absente ou vide' };
  }

  const trimmee = brute.trim();

  // Forme `host=... dbname=... user=...` : non prise en charge, signalée sans
  // être devinée. Prisma n'accepte de toute façon que la forme URL.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmee)) {
    return { nom, present: true, raison: 'forme mot-clé, non une URL — non analysée' };
  }

  let url;
  try {
    url = new URL(trimmee);
  } catch {
    return { nom, present: true, raison: 'URL illisible' };
  }

  const protocole = url.protocol.replace(/:$/, '').toLowerCase();
  if (protocole !== 'postgresql' && protocole !== 'postgres') {
    return { nom, present: true, raison: `schéma inattendu « ${protocole} »` };
  }

  const motDePasse = url.password ? decodeURIComponent(url.password) : '';
  // Le mot de passe est le seul élément traité par fragments. `url.password`
  // brut aussi : une valeur non décodée ne doit pas passer entre les mailles.
  interdireFragments(motDePasse);
  interdireFragments(url.password);

  return {
    nom,
    present: true,
    hote: url.hostname.toLowerCase(),
    port: url.port || '5432',
    base: decodeURIComponent(url.pathname.replace(/^\/+/, '')) || '(aucune)',
    utilisateur: url.username ? decodeURIComponent(url.username) : '(aucun)',
    sslmode: url.searchParams.get('sslmode') || '(absent)',
    aMotDePasse: motDePasse !== '',
    empreinte: empreinte(trimmee),
    longueur: trimmee.length,
  };
}

/* --- Exécution ------------------------------------------------------------- */

const resultats = VARIABLES.map((nom) => analyser(nom, process.env[nom]));

publier('');
publier('  Cibles de base de données — comparaison sans affichage');
publier('  Aucune connexion ouverte · aucune requête SQL · aucune écriture');
publier('');

for (const r of resultats) {
  publier(`  ${r.nom}`);
  if (!r.present) {
    publier(`    absente : ${r.raison}`);
    publier('');
    continue;
  }
  if (r.raison) {
    publier(`    non analysée : ${r.raison}`);
    publier(`    empreinte : ${r.empreinte}`);
    publier('');
    continue;
  }
  publier(`    hôte        : ${r.hote}`);
  publier(`    port        : ${r.port}`);
  publier(`    base        : ${r.base}`);
  publier(`    utilisateur : ${r.utilisateur}`);
  publier(`    sslmode     : ${r.sslmode}`);
  publier(`    empreinte   : ${r.empreinte}  (${r.longueur} caractères)`);
  publier('');
}

const manquantes = resultats.filter((r) => !r.present || r.raison);
if (manquantes.length > 0) {
  publier(`  NON COMPARABLE — ${manquantes.map((r) => r.nom).join(', ')}`);
  publier('  Aucune déduction n\'est faite sur une valeur absente ou illisible.');
  publier('');
  process.exit(SORTIE_ABSENTE);
}

const [a, b] = resultats;
const champs = [
  ['hôte', a.hote, b.hote],
  ['port', a.port, b.port],
  ['base', a.base, b.base],
  ['utilisateur', a.utilisateur, b.utilisateur],
];

publier('  Comparaison');
for (const [libelle, va, vb] of champs) {
  publier(`    ${libelle.padEnd(12)} : ${va === vb ? 'IDENTIQUE' : 'DIFFÉRENT'}   (${va} | ${vb})`);
}
publier('');

const memeInstance = a.hote === b.hote && a.port === b.port;
const memeBase = a.base === b.base;
const memeUtilisateur = a.utilisateur === b.utilisateur;

if (memeInstance && memeBase && memeUtilisateur) {
  publier('  VERDICT : cibles STRICTEMENT IDENTIQUES — même instance, même base, même utilisateur.');
  publier('  Les deux variables désignent le même rôle : aucun changement de privilèges à en attendre.');
  publier('');
  process.exit(SORTIE_IDENTIQUE);
}

if (memeInstance && memeBase && !memeUtilisateur) {
  publier('  VERDICT : MÊME INSTANCE ET MÊME BASE, UTILISATEURS DIFFÉRENTS.');
  publier(`  ${a.utilisateur} d'un côté, ${b.utilisateur} de l'autre : la seule différence`);
  publier('  est le rôle, donc les privilèges et l\'assujettissement à la RLS.');
  publier('  C\'est la configuration attendue pour une bascule vers un rôle restreint.');
  publier('');
  process.exit(SORTIE_DIFFERENT);
}

if (!memeInstance) {
  publier('  VERDICT : INSTANCES DIFFÉRENTES.');
  publier(`  ${a.hote} n'est pas ${b.hote}.`);
  publier('  Les deux variables ne visent pas le même serveur : toute conclusion tirée');
  publier('  de l\'une ne vaut pas pour l\'autre.');
  publier('');
  process.exit(SORTIE_DIFFERENT);
}

publier('  VERDICT : même instance mais BASES DIFFÉRENTES.');
publier(`  ${a.base} d'un côté, ${b.base} de l'autre.`);
publier('');
process.exit(SORTIE_DIFFERENT);
