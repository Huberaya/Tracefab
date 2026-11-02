/**
 * Bases ephmeres : creer, prouver, detruire — sans jamais detruire autre chose.
 *
 * POURQUOI CE MODULE
 *
 * Deux suites (`test_isolation_lignes_reelles`, `test_compteurs_debit`) creaient
 * leur base de travail sous un nom FIXE :
 *
 *     const BASE_EPHEMERE = 'tracefab_compteurs_debit';
 *     await admin.query(`DROP DATABASE IF EXISTS ${BASE_EPHEMERE}`);
 *     await admin.query(`CREATE DATABASE ${BASE_EPHEMERE}`);
 *
 * Mesure du 29/10 sur un cluster jetable : une base PREEXISTANTE portant ce nom
 * et une ligne de donnee metier a ete detruite par ce `DROP ... IF EXISTS`, et
 * la suite est sortie VERTE (code 0). Aucune trace, aucune erreur. Le nom fixe
 * transforme donc une suite de test en effaceur de base : il suffit qu'une
 * execution parallele, une execution precedente interrompue, ou une base
 * homonyme reelle occupe ce nom.
 *
 * CE QUE CE MODULE GARANTIT, ET COMMENT
 *
 *   1. NOM UNIQUE — prefixe + horodatage + alea, minuscules, `[a-z0-9_]`,
 *      tronque a 63 OCTETS (la limite PostgreSQL, comptee en octets et non en
 *      caracteres).
 *   2. AUCUN `DROP` AVANT `CREATE` — le nom est verifie ABSENT avant creation.
 *      Collision : on tire un autre nom. `CREATE` qui renvoie 42P04
 *      (`duplicate_database`) est traite comme une collision d'execution
 *      parallele : nouvel essai, jamais de suppression.
 *   3. PREUVE DE PROPRIETE — l'OID de la base est releve immediatement apres
 *      le `CREATE` et conserve. C'est le seul jeton qui autorise une
 *      destruction. Un nom peut etre reutilise par quelqu'un d'autre apres
 *      coup ; un OID, non.
 *   4. MEME SERVEUR, MEME CLUSTER — la connexion de maintenance et la
 *      connexion de travail doivent rapporter le meme `system_identifier`
 *      (`pg_control_system()`), le meme couple adresse/port, et la connexion de
 *      travail doit etre reellement dans la base creee (meme OID). Une URL
 *      derivee n'est PAS supposee sure parce qu'on a remplace un nom de base :
 *      elle est reclassifiee et reverifiee par connexion.
 *   5. ARRET SANS SUPPRESSION — si une verification echoue, la base n'est
 *      jamais detruite : on ne detruit pas ce qu'on n'a pas prouve.
 *   6. NETTOYAGE DANS `finally`, UNIQUEMENT SUR L'OID CREE.
 *
 * Ce module ne prend AUCUNE decision sur la cible : il recoit une URL deja
 * classee par `require-throwaway-db.mjs`, et se contente de ne pas aggraver.
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './pg-ssl.mjs';
import { classifyTarget } from './require-throwaway-db.mjs';
import { enregistrerRessource } from './manifeste_jetable.mjs';

/** Limite PostgreSQL : 63 octets pour un identifiant. */
const LONGUEUR_MAX_IDENTIFIANT = 63;
/** Une base de maintenance doit exister dans tout cluster. */
const BASE_MAINTENANCE = 'postgres';
/**
 * Cle du verrou consultatif de CLUSTER. Identique partout : `run-db-suite.mjs`,
 * `base_jetable.mjs`, les suites de garde. Une seule valeur, une seule verite.
 */
export const CLE_VERROU_CLUSTER = 738241901;
/**
 * Attente par defaut pour une DESTRUCTION (R9, 30/10). Court volontairement :
 * une destruction qui attend longtemps est une destruction qui bloque une
 * suite ; au-dela, on refuse. Un refus se lit, une attente infinie non.
 */
export const ATTENTE_DESTRUCTION_MS = 5000;
/** Essais avant d'abandonner sur collision. */
const ESSAIS_NOM = 8;

/** Caracteres autorises dans un nom de base genere. */
const NOM_VALIDE = /^[a-z][a-z0-9_]*$/;

/**
 * Construit un nom de base unique et conforme.
 *
 * Le suffixe melange horodatage et alea : l'horodatage seul collisionne entre
 * deux executions demarrees dans la meme milliseconde (mesure : huit suites
 * lancees en parallele par le lanceur commun), l'alea seul ne dit rien d'utile
 * dans un journal. Les deux ensemble donnent un nom triable ET unique.
 *
 * La troncature se fait sur les OCTETS, pas sur les caracteres : PostgreSQL
 * refuse un identifiant de plus de 63 octets, et un prefixe accentue compterait
 * double.
 */
export function nomBaseEphemere(prefixe = 'tf_ephemere') {
  let base = String(prefixe)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[^a-z]+/, '');
  // Un prefixe qui ne commence pas par une lettre (accents, chiffres, ponctuation)
  // ne doit pas produire un identifiant invalide : on rétablit une initiale.
  if (!/^[a-z]/.test(base)) base = `tf_${base}`;
  const horodatage = Date.now().toString(36);
  const alea = crypto.randomBytes(6).toString('hex');
  let nom = `${base}_${horodatage}_${alea}`;
  while (Buffer.byteLength(nom, 'utf8') > LONGUEUR_MAX_IDENTIFIANT) {
    nom = nom.slice(0, -1);
  }
  // Un nom tronque ne doit jamais finir par un separateur : on le retire.
  nom = nom.replace(/_+$/, '');
  if (!NOM_VALIDE.test(nom)) {
    throw new Error(`nom de base ephemere invalide : ${nom}`);
  }
  return nom;
}

/** Identifiant SQL sur : le nom a ete valide ci-dessus. */
function ident(nom) {
  if (!NOM_VALIDE.test(nom)) throw new Error(`identifiant refuse : ${nom}`);
  return `"${nom}"`;
}

/**
 * Derive une URL vers une autre base, SANS la supposer sure.
 *
 * On ne fait pas de substitution textuelle : on analyse l'URL, on remplace le
 * chemin, et on reclassifie le resultat. Une URL derivee reste une cible a
 * prouver — c'est precisement ce que demandait le constat.
 */
export function deriverUrl(urlSource, nomBase) {
  const u = new URL(urlSource);
  u.pathname = `/${nomBase}`;
  return u.toString();
}

/**
 * Empreinte d'identite d'un cluster. `pg_control_system()` renvoie
 * `system_identifier`, qui est propre a un cluster donne et stable dans le
 * temps : c'est la seule facon de distinguer deux serveurs qui repondraient sur
 * le meme nom d'hote et le meme port.
 */
export async function identiteServeur(client) {
  const { rows } = await client.query(`
    SELECT (SELECT system_identifier FROM pg_control_system()) AS system_identifier,
           inet_server_addr()::text AS adresse,
           inet_server_port()       AS port,
           current_database()       AS base`);
  const r = rows[0];
  return {
    systemIdentifier: String(r.system_identifier),
    adresse: r.adresse ?? '(socket local)',
    port: r.port,
    base: r.base,
  };
}

function memeCluster(a, b) {
  return a.systemIdentifier === b.systemIdentifier
    && a.adresse === b.adresse
    && a.port === b.port;
}

/** Ouvre un client ; l'appelant ferme. */
async function ouvrir(url) {
  const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await client.connect();
  return client;
}

/**
 * Cree une base ephemere et prouve qu'elle est bien la sienne.
 *
 * @param {object} options
 * @param {string} options.urlProprietaire URL deja classee par la garde
 * @param {string} options.prefixe          prefixe lisible dans le nom
 * @returns {Promise<{nom, oid, url, identite, fermer}>}
 */
export async function creerBaseEphemere({
  urlProprietaire,
  prefixe = 'tf_ephemere',
  // Injectable UNIQUEMENT pour les controles negatifs : permet de forcer une
  // collision de nom et de prouver qu'aucune base preexistante n'est detruite.
  generateurNom = () => nomBaseEphemere(prefixe),
}) {
  // La base source elle-meme doit etre classable : on ne derive pas depuis une
  // cible qu'on n'a pas su qualifier.
  const verdictSource = classifyTarget(urlProprietaire);
  if (!verdictSource.allowed) {
    throw new Error(`source non autorisee (${verdictSource.code}) : ${verdictSource.reason}`);
  }

  const urlMaintenance = deriverUrl(urlProprietaire, BASE_MAINTENANCE);
  // Une URL derivee n'est pas sûre par construction : on la reclassifie.
  const verdictMaintenance = classifyTarget(urlMaintenance);
  if (!verdictMaintenance.allowed) {
    throw new Error(`maintenance refusee (${verdictMaintenance.code}) : ${verdictMaintenance.reason}`);
  }

  const admin = await ouvrir(urlMaintenance);
  let nom = null;
  let oid = null;
  let creee = false;
  // Fermeture sûre, disponible seulement une fois l'OID prouve.
  let nettoyageProuve = null;
  try {
    const identiteMaintenance = await identiteServeur(admin);

    for (let essai = 0; essai < ESSAIS_NOM; essai += 1) {
      const candidat = generateurNom();
      // 2. Le nom doit etre ABSENT. `IF EXISTS` n'existe pas pour CREATE
      // DATABASE, mais la verification explicite rend le refus lisible et
      // interdit toute tentation de « nettoyer d'abord ».
      const occupe = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [candidat]);
      if (occupe.rowCount > 0) continue;
      try {
        await admin.query(`CREATE DATABASE ${ident(candidat)}`);
        nom = candidat;
        creee = true;
      } catch (e) {
        // Collision avec une execution parallele : une base du meme nom a ete
        // creee entre la verification et le CREATE. C'est une collision, pas
        // une erreur : on retire un nom.
        //
        // MESURE du 29/10 sur PostgreSQL 17.10 : CREATE DATABASE en collision
        // leve **23505** (`unique_violation` sur `pg_database_datname_index`),
        // PAS 42P04. Ne traiter que 42P04 laissait passer l'exception et
        // interrompait l'execution — la garde devenait inutilisable des que
        // deux suites demarraient ensemble. Les deux codes sont donc traites.
        if (e.code === '42P04' || e.code === '23505') continue;
        throw e;
      }
      break;
    }

    if (!nom) {
      throw new Error(`aucun nom de base libre apres ${ESSAIS_NOM} essais — arret sans suppression`);
    }

    // 3. Preuve de propriete : l'OID de la base que ce processus vient de creer.
    // A partir d'ici, une destruction est CERTAINE et non « incertaine » : elle
    // ne peut viser que cet OID. Avant, elle reste interdite.
    const { rows } = await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [nom]);
    oid = rows[0]?.oid;
    if (!oid) throw new Error('base creee introuvable dans pg_database — arret sans suppression');
    nettoyageProuve = async () => avecVerrouDeCluster({ urlProprietaire, urlMaintenance }, async () => {
      // La preuve d'OID et le DROP sont DANS la section critique : relire l'OID
      // hors du verrou laisserait une fenetre ou la base peut etre supprimee et
      // recreee entre la verification et la destruction.
      const nettoyeur = await ouvrir(urlMaintenance);
      try {
        const { rows: actuelles } = await nettoyeur.query(
          'SELECT oid FROM pg_database WHERE datname = $1', [nom],
        );
        if (String(actuelles[0]?.oid) !== String(oid)) {
          throw new Error(`la base ${nom} n a plus l OID cree (${oid}) — destruction refusee`);
        }
        // `WITH (FORCE)` termine les sessions encore attachees. Il ne s'applique
        // qu'a la base dont l'OID vient d'etre verifie : c'est la notre, et une
        // suite interrompue laisse forcement des connexions ouvertes.
        await nettoyeur.query(`DROP DATABASE ${ident(nom)} WITH (FORCE)`);
      } finally {
        await nettoyeur.end();
      }
    });

    // 4. La connexion de travail doit etre dans CETTE base, sur CE cluster.
    const url = deriverUrl(urlProprietaire, nom);
    const verdictTravail = classifyTarget(url);
    if (!verdictTravail.allowed) {
      throw new Error(`URL de travail refusee (${verdictTravail.code}) — arret sans suppression`);
    }
    const controle = await ouvrir(url);
    let identiteTravail;
    try {
      identiteTravail = await identiteServeur(controle);
      const { rows: oidRows } = await controle.query(
        'SELECT oid FROM pg_database WHERE datname = current_database()',
      );
      if (String(oidRows[0]?.oid) !== String(oid)) {
        throw new Error('la connexion de travail n est pas dans la base creee — arret sans suppression');
      }
    } finally {
      await controle.end();
    }
    if (!memeCluster(identiteMaintenance, identiteTravail)) {
      throw new Error(
        'maintenance et travail ne visent pas le meme cluster '
        + `(${identiteMaintenance.systemIdentifier} vs ${identiteTravail.systemIdentifier}) — arret sans suppression`,
      );
    }

    // R6 (30/10) : preuve de creation, ecrite AU MOMENT ou l'OID et l'identite
    // du cluster sont connus. C'est le seul jeton qui autorisera une reprise
    // apres interruption brutale — un prefixe ne suffira jamais.
    enregistrerRessource({
      genre: 'base',
      nom,
      oid,
      systemIdentifier: identiteTravail.systemIdentifier,
    });

    return {
      nom,
      oid: String(oid),
      url,
      identite: identiteTravail,
      urlMaintenance,
      /** Detruit la base, UNIQUEMENT si l'OID est toujours celui qu'on a cree. */
      async fermer() {
        // Quelqu'un a pu supprimer puis recreer une base du meme nom : l'OID
        // le dit, et dans ce cas on refuse de detruire ce qui n'est plus la
        // notre.
        await nettoyageProuve();
        return true;
      },
    };
  } catch (erreur) {
    // 5/7. Une verification a echoue. On ne detruit QUE si l'OID a deja ete
    // prouve — au-dela, la destruction serait incertaine et donc interdite.
    // Une base nommee mais non prouvee est signalee, jamais supprimee.
    if (nettoyageProuve) {
      try {
        await nettoyageProuve();
      } catch (eNettoyage) {
        throw new Error(`${erreur.message} — et le nettoyage a echoue : ${eNettoyage.message}`);
      }
    } else if (creee && nom) {
      throw new Error(
        `${erreur.message} — base ${nom} CREEE mais NON PROUVEE : destruction refusee `
        + '(suppression incertaine). A retirer manuellement.',
      );
    }
    throw erreur;
  } finally {
    await admin.end();
  }
}

/** Verrous de cluster pris par CE processus, et encore tenus. */
const verrousDuProcessus = new Set();

/** Vrai si ce processus tient deja le verrou de cluster. */
export function detientVerrouDeCluster() {
  return verrousDuProcessus.size > 0;
}

/**
 * Le verrou de cluster est-il tenu par un LANCEUR ANCETRE de ce processus ?
 *
 * `run-db-suite.mjs --verrou-cluster` prend le verrou dans le parent, puis
 * lance l'enfant : l'enfant ne peut pas reprendre un verrou consultatif deja
 * detenu par une AUTRE session. Sans cette preuve, toute destruction faite par
 * un enfant sous `--verrou-cluster` echouerait — ce qui punirait les suites qui
 * font exactement ce qu'on leur demande.
 *
 * La preuve n'est pas une declaration d'environnement : le PID transmis doit
 * apparaitre dans `pg_locks` comme detenteur effectif de la cle.
 */
async function verrouTenueParUnAncetre(client) {
  const pid = Number(process.env.TF_VERROU_CLUSTER_DETENEUR || 0);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const { rows } = await client.query(
    `SELECT count(*)::int AS n
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND objsubid = 1
        AND granted
        AND ((classid::bigint << 32) | objid::bigint) = $1
        AND pid = $2`,
    [CLE_VERROU_CLUSTER, pid],
  );
  return rows[0].n === 1 ? pid : null;
}

/**
 * Section critique de CLUSTER — FAIL-CLOSED (R9, 30/10).
 *
 * Mesure avant correction : `base.fermer()` detruisait une base en 119 ms alors
 * qu'une session tierce detenait le verrou, tuant la session de travail
 * concernee (`57P01 terminating connection due to administrator command`) et
 * les ecritures non validees avec elle. Le chemin de REMISE A ZERO, lui,
 * attendait le verrou : l'invariant n'existait donc que sur la moitie des
 * chemins.
 *
 * Ordre des preuves, du moins couteux au plus couteux :
 *   1. le verrou est deja tenu par ce processus          -> on continue ;
 *   2. il est tenu par un lanceur ancetre (PID prouve)   -> on continue ;
 *   3. on l'acquiert nous-memes, attente BORNEE          -> on rend le verrou ;
 *   4. sinon : on REFUSE. Aucune action n'est executee, aucune destruction.
 *
 * @param {{urlProprietaire?: string, urlMaintenance?: string}} cible
 * @param {(contexte: {mode: string}) => Promise<any>} action
 * @param {{attenteMs?: number, urlProprietaire?: string}} [options]
 */
export async function avecVerrouDeCluster(cible, action, { attenteMs = ATTENTE_DESTRUCTION_MS } = {}) {
  const urlProprietaire = cible?.urlProprietaire;
  const urlMaintenance = cible?.urlMaintenance ?? deriverUrl(urlProprietaire, BASE_MAINTENANCE);

  if (detientVerrouDeCluster()) return action({ mode: 'processus' });

  const client = await ouvrir(urlMaintenance);
  try {
    const ancetre = await verrouTenueParUnAncetre(client);
    if (ancetre !== null) return await action({ mode: 'herite', pid: ancetre });

    const limite = Date.now() + Math.max(0, attenteMs);
    let pris = false;
    for (;;) {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS pris', [CLE_VERROU_CLUSTER]);
      if (rows[0].pris === true) { pris = true; break; }
      if (Date.now() >= limite) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!pris) {
      const e = new Error(
        `verrou de cluster ${CLE_VERROU_CLUSTER} indisponible apres ${attenteMs} ms`
        + ' — operation destructive REFUSEE (aucune ressource touchee)',
      );
      e.code = 'TF_VERROU_INDISPONIBLE';
      e.exitCode = 3;
      throw e;
    }
    verrousDuProcessus.add('section');
    try {
      return await action({ mode: 'propre' });
    } finally {
      verrousDuProcessus.delete('section');
      await client.query('SELECT pg_advisory_unlock($1)', [CLE_VERROU_CLUSTER]).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Verrou consultatif de CLUSTER, pour les phases qui touchent des objets
 * partages par toutes les bases d'un meme serveur.
 *
 * MESURE du 30/10 sur PG 17.10, deux suites lancees en parallele sur le meme
 * cluster :
 *   — `ALTER ROLE tracefab_app ...` concurrent  -> XX000 `tuple concurrently
 *     updated` (1 execution sur 3) ;
 *   — la migration `20261028120100_worker_identity_not_forgeable`, qui elle
 *     aussi vise le role de cluster, echouait de la meme facon, laissant la
 *     chaine a moitie appliquee et une assertion d ecriture directe en echec.
 * Les bases ephemeres, elles, ne se genent pas : c'est bien le CLUSTER qui est
 * le point de serialisation.
 *
 * Ce verrou ne remplace pas la garde : il ordonne seulement des phases qui
 * ecrivent dans les catalogues partages (`pg_authid`, ACL de role).
 *
 * @param {{urlMaintenance: string}} base base ephemere creee par la garde
 * @param {number} [cle] cle arbitraire, identique pour tous les appelants
 */
export async function verrouillerCluster(base, cle = 738241901, { attenteMs = null } = {}) {
  const urlMaintenance = base.urlMaintenance ?? deriverUrl(base.urlProprietaire, BASE_MAINTENANCE);
  const client = await ouvrir(urlMaintenance);
  if (attenteMs === null) {
    // Comportement historique : on attend le verrou aussi longtemps qu'il faut.
    await client.query('SELECT pg_advisory_lock($1)', [cle]);
  } else {
    // Attente BORNEE : utilisee par les chemins qui doivent echouer plutot que
    // d attendre indefiniment (lanceur commun, `--verrou-cluster`). Mesure du
    // 30/10 : un verrou deja detenu par une autre session bloquait l appelant
    // sans limite, ce qui n est pas un comportement de garde.
    const limite = Date.now() + Math.max(0, attenteMs);
    let pris = false;
    while (!pris) {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS pris', [cle]);
      pris = rows[0].pris === true;
      if (pris) break;
      if (Date.now() >= limite) {
        await client.end().catch(() => {});
        const e = new Error(`verrou de cluster ${cle} indisponible apres ${attenteMs} ms`);
        e.code = 'TF_VERROU_INDISPONIBLE';
        throw e;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // PID du backend qui detient le verrou : transmis aux enfants pour qu'ils
  // puissent PROUVER (dans `pg_locks`) qu'un ancetre serialise le cluster, au
  // lieu de le supposer.
  const { rows: pidRows } = await client.query('SELECT pg_backend_pid() AS pid');
  const pid = Number(pidRows[0].pid);

  verrousDuProcessus.add('verrouillerCluster');
  let relache = false;
  const relacher = async () => {
    if (relache) return;
    relache = true;
    verrousDuProcessus.delete('verrouillerCluster');
    // `pg_advisory_unlock_all` : on ne depend pas du comptage exact des
    // verrous pris, et la session est de toute facon fermee ensuite.
    await client.query('SELECT pg_advisory_unlock_all()').catch(() => {});
    await client.end().catch(() => {});
  };

  // Filet pour les interruptions : un SIGINT/SIGTERM ne laisse pas le verrou
  // derriere lui. Une sortie BRUTALE (kill -9) est couverte autrement : la
  // session meurt, et PostgreSQL libere alors tous ses verrous consultatifs.
  // Ce comportement est verifie par scripts/test_verrou_cluster.mjs.
  if (!signauxInstalles) {
    signauxInstalles = true;
    installes = [];
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      const gestionnaire = () => {
        Promise.allSettled(installes.map((v) => v.relacher()))
          .finally(() => process.exit(code));
      };
      process.once(signal, gestionnaire);
    }
  }
  const verrou = { relacher, urlMaintenance, pid };
  installes.push(verrou);
  return verrou;
}

/** Verrous pris dans ce processus : utilises par le filet de signaux. */
let signauxInstalles = false;
let installes = [];

/**
 * Filet de nettoyage pour les suites qui creent plusieurs ressources.
 *
 * Un `finally` couvre ce qui est DANS le `try`. Ce qui se passe entre la
 * creation et l'entree dans le `try` — un `await` qui jette, un bug dans la
 * garde elle-meme — laissait la base et le role derriere. Mesure du 30/10 : une
 * exception levee juste apres `creerBaseEphemere` a laisse deux bases
 * `tf_privileges_*` sur le cluster.
 *
 * Le filet couvre les erreurs fatales ET les interruptions, et n'agit qu'une
 * fois.
 *
 * @param {() => Promise<void>} nettoyer
 */
export function filetDeNettoyage(nettoyer) {
  let fait = false;
  const declencher = async (code) => {
    if (fait) return;
    fait = true;
    try {
      await nettoyer();
    } catch {
      /* une fuite de nettoyage ne doit pas masquer l'erreur d'origine */
    }
    process.exit(code);
  };
  process.once('uncaughtException', (e) => {
    console.error(`  ARRET — ${e.code ?? String(e.message).split('\n')[0]}`);
    declencher(1);
  });
  process.once('unhandledRejection', (e) => {
    console.error(`  ARRET — ${e?.code ?? String(e?.message).split('\n')[0]}`);
    declencher(1);
  });
  return { declencher };
}

/**
 * Execute une suite dans une base ephemere, avec nettoyage garanti.
 *
 * Le nettoyage est dans un `finally` : une assertion qui leve, une migration en
 * echec, un `process.exit` evite par une exception — tout passe par la
 * destruction. Et cette destruction ne vise que l'OID cree.
 *
 * Si la destruction echoue, l'erreur est remontee : une base laissee derriere
 * n'est pas un detail, c'est une fuite.
 *
 * @param {object} options
 * @param {string} options.urlProprietaire
 * @param {string} options.prefixe
 * @param {(contexte: object) => Promise<any>} options.executer
 */
export async function avecBaseEphemere({ urlProprietaire, prefixe, executer }) {
  const base = await creerBaseEphemere({ urlProprietaire, prefixe });
  let resultat;
  let erreurExecution = null;
  try {
    resultat = await executer(base);
  } catch (e) {
    erreurExecution = e;
  } finally {
    try {
      await base.fermer();
    } catch (e) {
      if (erreurExecution) {
        // Les deux ont echoue : on rapporte la fuite, elle est plus grave que
        // l'echec de la suite.
        throw new Error(
          `echec de la suite ET de la destruction de ${base.nom} : ${e.message} `
          + `(cause initiale : ${erreurExecution.message})`,
        );
      }
      throw e;
    }
  }
  if (erreurExecution) throw erreurExecution;
  return resultat;
}
