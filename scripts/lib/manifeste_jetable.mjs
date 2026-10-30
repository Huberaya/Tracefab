/**
 * Manifeste des ressources jetables — la PREUVE DE CREATION (R6, 30/10).
 *
 * POURQUOI CE MODULE
 *
 * Une interruption brutale (`kill -9`, coupure du runner) ne laisse aucune
 * occasion de lancer un `finally`. Mesure du 30/10 sur PG 17.10 : un enfant tue
 * par `SIGKILL` laisse derriere lui sa base `tf_r6_…`, le role `tf_garde_r6_…`
 * qu'il avait cree, et une ligne de test dans cette base. Les verrous
 * consultatifs, eux, disparaissent avec la session : le residu est bien la
 * ressource, pas le verrou.
 *
 * CE QUE CE MODULE INTERDIT
 *
 * Une reprise qui supprimerait « tout ce qui commence par tf_ » serait plus
 * dangereuse que le residu : un prefixe n'est pas une preuve. Ce module
 * enregistre donc, AU MOMENT DE LA CREATION, le triplet qui autorise une
 * reprise plus tard :
 *
 *   — l'identite du CLUSTER (`system_identifier`, unique par cluster) ;
 *   — le NOM exact de la ressource ;
 *   — son OID, releve immediatement apres la creation.
 *
 * Le reprise (`scripts/nettoyer_ressources_jetables.mjs`) ne detruit que ce
 * triplet, revalide en direct : ni plus, ni moins.
 *
 * Le manifeste est un JSONL hors depot (par defaut `os.tmpdir()`), pour qu'il
 * ne pollue ni le diff ni le statut Git. Il est best-effort : une ecriture de
 * manifeste qui echoue ne doit jamais faire echouer une suite — c'est une trace,
 * pas une garde.
 */
import { appendFileSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Chemin du manifeste. Surchargeable pour les tests (`TF_MANIFESTE`). */
export function cheminManifeste() {
  return process.env.TF_MANIFESTE
    || path.join(os.tmpdir(), 'tracefab-jetables.jsonl');
}

/**
 * Instant de demarrage d'un processus, en ticks depuis le boot.
 *
 * Lu dans `/proc/<pid>/stat`, champ 22. On isole la partie apres la derniere
 * parenthese : le champ 2 (`comm`) peut contenir des espaces et des
 * parentheses, et decouper naivement la ligne decalerait tous les champs.
 *
 * Rend `null` hors Linux, ou si le processus n'existe pas.
 */
export function demarrageProcessus(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const finComm = stat.lastIndexOf(')');
    if (finComm === -1) return null;
    const champs = stat.slice(finComm + 2).split(' ');
    return champs[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Le createur enregistre est-il encore en train de tourner ?
 *
 * Trois conditions, toutes necessaires, parce qu'un PID recycle produirait
 * sinon un faux « vivant » qui empecherait toute reprise :
 *
 *   1. meme hote — un PID n'a de sens que sur la machine qui l'a vu naitre ;
 *   2. le PID existe ;
 *   3. son instant de demarrage est celui enregistre.
 *
 * Une entree SANS ces champs (manifeste ecrit par une version anterieure) est
 * traitee comme « createur inconnu » : elle n'empeche pas la reprise, et le
 * triplet nom/OID/cluster reste la seule autorisation.
 */
export function createurVivant(entree) {
  if (!entree || entree.pid === undefined || entree.pid === null) return false;
  if (entree.hote && entree.hote !== os.hostname()) return false;
  if (!entree.pid_debut) return false;
  const actuel = demarrageProcessus(entree.pid);
  return actuel !== null && String(actuel) === String(entree.pid_debut);
}

/**
 * Enregistre une ressource creee par un test.
 *
 * @param {object} entree
 * @param {'base'|'role'} entree.genre
 * @param {string} entree.nom
 * @param {string|number} entree.oid
 * @param {string|number} entree.systemIdentifier identite du cluster
 * @param {string} [entree.createur] etiquette lisible (script appelant)
 * @returns {boolean} vrai si la trace a ete ecrite
 */
export function enregistrerRessource({ genre, nom, oid, systemIdentifier, createur }) {
  if (!genre || !nom || oid === undefined || oid === null || !systemIdentifier) return false;
  const ligne = JSON.stringify({
    genre,
    nom: String(nom),
    oid: String(oid),
    systemIdentifier: String(systemIdentifier),
    createur: createur || path.basename(process.argv[1] || 'inconnu'),
    cree_le: new Date().toISOString(),
    pid: process.pid,
    // R4/R11 (P10.2) — de quoi prouver plus tard que le CREATEUR est encore
    // vivant, et pas seulement qu'un PID a existe.
    //
    // `pid` seul ne suffit pas : les PID sont recycles. On enregistre donc
    // l'instant de demarrage du processus (champ 22 de /proc/<pid>/stat,
    // exprime en ticks depuis le boot) et l'hote. Une entree dont le couple
    // (hote, pid, pid_debut) correspond encore a un processus vivant designe
    // une ressource EN COURS D'UTILISATION : la detruire reviendrait a
    // arracher la base sous les pieds d'un test en train de tourner.
    hote: os.hostname(),
    pid_debut: demarrageProcessus(process.pid),
  });
  try {
    const chemin = cheminManifeste();
    // Une interruption peut laisser une ligne SANS saut de ligne final. Sans
    // cette reparation, l'entree suivante serait collee a la ligne tronquee et
    // perdue avec elle — mesure du 30/10 : deux entrees valides avalees par une
    // seule ligne cassee.
    appendFileSync(chemin, `${finDeLigneManquant(chemin) ? '\n' : ''}${ligne}\n`, { flag: 'a' });
    return true;
  } catch {
    // Trace best-effort : jamais bloquante.
    return false;
  }
}

/**
 * Le fichier se termine-t-il par un saut de ligne exploitable ?
 * Un fichier absent ou vide est considere comme « pret » (rien a reparer).
 */
function finDeLigneManquant(chemin) {
  try {
    const { size } = statSync(chemin);
    if (size === 0) return false;
    const fd = openSync(chemin, 'r');
    try {
      const octet = Buffer.alloc(1);
      readSync(fd, octet, 0, 1, size - 1);
      return octet[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Lit le manifeste. Les lignes illisibles sont ignorees, pas devinees.
 * @returns {Array<{genre,nom,oid,systemIdentifier,createur,cree_le,pid}>}
 */
export function lireManifeste(chemin = cheminManifeste()) {
  let brut;
  try {
    brut = readFileSync(chemin, 'utf8');
  } catch {
    return [];
  }
  const entrees = [];
  for (const ligne of brut.split('\n')) {
    if (!ligne.trim()) continue;
    try {
      const e = JSON.parse(ligne);
      if (!e || !e.genre || !e.nom || e.oid === undefined || !e.systemIdentifier) continue;
      entrees.push({
        genre: e.genre,
        nom: String(e.nom),
        oid: String(e.oid),
        systemIdentifier: String(e.systemIdentifier),
        createur: e.createur,
        cree_le: e.cree_le,
        pid: e.pid,
        hote: e.hote,
        pid_debut: e.pid_debut,
      });
    } catch {
      // Une ligne tronquee par une interruption n'est pas exploitable : on
      // l'ignore. Elle ne doit jamais servir de preuve.
    }
  }
  return entrees;
}
